import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Abi, Address, PublicClient } from "viem";
import {
  deployWarehouses,
  ONE_TOKEN,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";
import { outboxAbi } from "../src/abis.js";
import {
  loadState,
  saveState,
  syncContractLogs,
  type IndexState,
} from "../src/indexer.js";
import { reconcile, type BridgeClients, type Deployment } from "../src/reconcile.js";

/**
 * Reading from the deployment block on every run is fine on one local chain and
 * wrong on a real network: the cost grows with the age of the chain, providers
 * reject oversized ranges outright, and the newest blocks are not settled.
 *
 * These tests cover the three properties that fix: bounded chunks, a checkpoint
 * that survives a crash, and a confirmations buffer.
 */

function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), "gatehouse-index-"));
}

async function setUp() {
  const context = await deployWarehouses();
  const client = (await context.viem.getPublicClient()) as unknown as PublicClient;
  const dir = scratchDir();

  // Ship a few messages so there is something to index.
  for (const note of ["one", "two", "three"]) {
    await context.outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      context.inbox.address,
      note,
    ]);
  }

  return {
    ...context,
    client,
    statePath: join(dir, "outbox.json"),
    target: {
      address: context.outbox.address as Address,
      abi: outboxAbi as unknown as Abi,
      eventNames: ["DeliveryShipped", "CargoShipped"],
      fromBlock: 0n,
    },
  };
}

describe("The index resumes instead of rescanning", function () {
  it("indexes everything on a first run", async function () {
    const { client, target, statePath } = await setUp();

    const result = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });

    assert.equal(result.logs.DeliveryShipped?.length, 3);
    assert.ok(result.blocksScanned > 0n);
    assert.ok(result.chunksFetched > 0);
  });

  it("does no work at all on a second run with no new blocks", async function () {
    const { client, target, statePath } = await setUp();

    await syncContractLogs(client, target, { statePath, confirmations: 0n });
    const second = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });

    // The whole point: the second pass reads no blocks and issues no requests,
    // yet still returns the full history.
    assert.equal(second.blocksScanned, 0n);
    assert.equal(second.chunksFetched, 0);
    assert.equal(second.logs.DeliveryShipped?.length, 3);
  });

  it("picks up only what is new", async function () {
    const { client, target, statePath, outbox, inbox } = await setUp();

    const first = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });
    const checkpoint = first.state.lastProcessedBlock;

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "four"]);

    const second = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });

    assert.ok(second.state.lastProcessedBlock > checkpoint);
    assert.equal(second.logs.DeliveryShipped?.length, 4);
  });

  it("splits the range into bounded chunks", async function () {
    const { client, target, statePath } = await setUp();

    // A tiny chunk size stands in for a provider's block-range ceiling. Past
    // that ceiling a single request would be rejected outright, not merely slow.
    const result = await syncContractLogs(client, target, {
      statePath,
      chunkSize: 2n,
      confirmations: 0n,
    });

    // Two event names per chunk, and more than one chunk was needed.
    assert.ok(result.chunksFetched > 2);
    assert.equal(result.logs.DeliveryShipped?.length, 3);
  });
});

describe("The checkpoint survives a crash", function () {
  it("resumes from a partially written index without duplicating", async function () {
    const { client, target, statePath } = await setUp();

    const complete = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });
    assert.equal(complete.logs.DeliveryShipped?.length, 3);

    // Simulate a crash after the first chunk: rewind the checkpoint and drop
    // everything recorded after it, exactly as an interrupted run would leave
    // things.
    const state = loadState(statePath) as IndexState;
    const rewindTo = state.fromBlock;
    state.lastProcessedBlock = rewindTo;
    state.logs = state.logs.filter((log) => log.blockNumber <= rewindTo);
    saveState(statePath, state);

    const resumed = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });

    // Re-reading the boundary must not double-count.
    assert.equal(resumed.logs.DeliveryShipped?.length, 3);
    const keys = (resumed.logs.DeliveryShipped ?? []).map(
      (log) => `${log.transactionHash}:${log.logIndex}`,
    );
    assert.equal(new Set(keys).size, keys.length);
  });

  it("starts over rather than resuming against a different contract", async function () {
    const { client, target, statePath } = await setUp();

    await syncContractLogs(client, target, { statePath, confirmations: 0n });

    // A state file from another deployment must not be adopted: mixing two
    // contracts' histories would silently corrupt every ledger comparison.
    const state = loadState(statePath) as IndexState;
    state.address = "0x000000000000000000000000000000000000dEaD";
    saveState(statePath, state);

    const result = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });

    assert.equal(result.state.address.toLowerCase(), target.address.toLowerCase());
    assert.equal(result.logs.DeliveryShipped?.length, 3);
  });

  it("writes state atomically, so a torn file is never observed", async function () {
    const { client, target, statePath } = await setUp();
    await syncContractLogs(client, target, { statePath, confirmations: 0n });

    // Whatever is at the path parses. The temp-then-rename in saveState is what
    // guarantees it: a plain write interrupted midway leaves a truncated file
    // that reads back as "no checkpoint" and silently rescans from scratch.
    const raw = readFileSync(statePath, "utf8");
    assert.doesNotThrow(() => JSON.parse(raw));

    // A genuinely corrupt file is treated as absent rather than crashing.
    writeFileSync(statePath, "{ this is not json");
    assert.equal(loadState(statePath), undefined);
  });
});

describe("The confirmations buffer holds back unsettled blocks", function () {
  it("does not commit logs from blocks that could still be reorganised", async function () {
    const { client, target, statePath } = await setUp();

    // Hold back more blocks than exist, so nothing is safe to commit yet.
    const head = await client.getBlockNumber();
    const result = await syncContractLogs(client, target, {
      statePath,
      confirmations: head + 10n,
    });

    assert.equal(result.blocksScanned, 0n);
    assert.equal(result.logs.DeliveryShipped, undefined);

    // With no buffer, the same blocks index normally.
    const settled = await syncContractLogs(client, target, {
      statePath,
      confirmations: 0n,
    });
    assert.equal(settled.logs.DeliveryShipped?.length, 3);
  });
});

describe("Indexed and direct reconciliation agree", function () {
  it("produces the same report either way", async function () {
    const context = await deployWarehouses();
    const publicClient =
      (await context.viem.getPublicClient()) as unknown as PublicClient;
    const clients: BridgeClients = {
      source: publicClient,
      destination: publicClient,
    };
    const dir = scratchDir();

    const deployment: Deployment = {
      outbox: context.outbox.address as Address,
      inbox: context.inbox.address as Address,
      tokens: [
        {
          symbol: "CCIP-BnM",
          source: context.testToken as Address,
          destination: context.testToken as Address,
        },
      ],
      sourceChainSelector: SEPOLIA_SELECTOR.toString(),
      destinationChainSelector: SEPOLIA_SELECTOR.toString(),
      expectedLatencySeconds: 0,
    };

    await context.outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      context.inbox.address,
      "a delivery",
    ]);

    const direct = await reconcile(clients, deployment);
    const indexed = await reconcile(clients, deployment, {
      index: {
        sourceStatePath: join(dir, "source.json"),
        destinationStatePath: join(dir, "destination.json"),
        confirmations: 0n,
      },
    });

    // Same conclusions, different cost. Nothing downstream can tell which
    // reader produced the rows.
    assert.equal(indexed.messages.length, direct.messages.length);
    assert.equal(indexed.healthy, direct.healthy);
    assert.deepEqual(
      indexed.findings.map((f) => f.code),
      direct.findings.map((f) => f.code),
    );
    assert.equal(indexed.ledgers[0].shipped, direct.ledgers[0].shipped);
    assert.equal(indexed.ledgers[0].received, direct.ledgers[0].received);
  });

  it("does not report a shipment inside the confirmations buffer as missing", async function () {
    const context = await deployWarehouses();
    const publicClient =
      (await context.viem.getPublicClient()) as unknown as PublicClient;
    const clients: BridgeClients = {
      source: publicClient,
      destination: publicClient,
    };
    const dir = scratchDir();
    const deployedAt = await publicClient.getBlockNumber();

    // Ship into the void, then reconcile with a buffer wide enough to hold the
    // shipment back. Contract state read at the chain head would show
    // totalShipped moving while the event is still behind the buffer, and the
    // difference would be reported as missing cargo - a false alarm on every
    // shipment for the length of the buffer, which is how an alert channel
    // stops being believed.
    const [, nowhere] = await context.viem.getWalletClients();
    await context.outbox.write.setDestination([
      SEPOLIA_SELECTOR,
      nowhere.account.address,
      true,
    ]);
    await context.outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      nowhere.account.address,
      "just sent",
    ]);

    const head = await publicClient.getBlockNumber();
    const report = await reconcile(
      clients,
      {
        ...deployment(context),
        // A real deployment always records where its contracts were deployed;
        // the indexed path relies on it to know how far back to pin reads.
        fromBlock: { source: deployedAt, destination: deployedAt },
      },
      {
        index: {
          sourceStatePath: join(dir, "source.json"),
          destinationStatePath: join(dir, "destination.json"),
          confirmations: head, // hold everything back
        },
      },
    );

    // Reads are pinned to the height the events are complete to, so state and
    // events describe the same moment and nothing looks missing.
    assert.equal(report.ledgers[0].shipped, 0n);
    assert.equal(report.ledgers[0].missing, 0n);
    assert.equal(
      report.findings.some((f) => f.code === "LEDGER_GAP"),
      false,
    );
    assert.equal(report.healthy, true);
  });

  it("reuses the checkpoint on a second reconciliation", async function () {
    const context = await deployWarehouses();
    const publicClient =
      (await context.viem.getPublicClient()) as unknown as PublicClient;
    const clients: BridgeClients = {
      source: publicClient,
      destination: publicClient,
    };
    const dir = scratchDir();
    const index = {
      sourceStatePath: join(dir, "source.json"),
      destinationStatePath: join(dir, "destination.json"),
      confirmations: 0n,
    };

    await context.outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      context.inbox.address,
      "a delivery",
    ]);

    await reconcile(clients, deployment(context), index && { index });
    const before = loadState(index.sourceStatePath) as IndexState;

    await reconcile(clients, deployment(context), { index });
    const after = loadState(index.sourceStatePath) as IndexState;

    // No new blocks, so the checkpoint has not moved and the history is intact.
    assert.equal(after.lastProcessedBlock, before.lastProcessedBlock);
    assert.equal(after.logs.length, before.logs.length);
    assert.ok(after.logs.length > 0);
  });

  function deployment(
    context: Awaited<ReturnType<typeof deployWarehouses>>,
  ): Deployment {
    return {
      outbox: context.outbox.address as Address,
      inbox: context.inbox.address as Address,
      tokens: [
        {
          symbol: "CCIP-BnM",
          source: context.testToken as Address,
          destination: context.testToken as Address,
        },
      ],
      sourceChainSelector: SEPOLIA_SELECTOR.toString(),
      destinationChainSelector: SEPOLIA_SELECTOR.toString(),
      expectedLatencySeconds: 0,
    };
  }
});

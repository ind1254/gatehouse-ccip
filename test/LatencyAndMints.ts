import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAbi, type Address, type PublicClient } from "viem";
import {
  deployWarehouses,
  dripTokens,
  ONE_TOKEN,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";
import {
  MISSING_MULTIPLIER,
  reconcile,
  type BridgeClients,
  type Deployment,
} from "../src/reconcile.js";

/**
 * Two defects found by reasoning about what happens on a real network rather
 * than a simulator:
 *
 *  1. A message that has not arrived yet is not a message that is lost. Every
 *     healthy delivery spends minutes "shipped but not received", dominated by
 *     source-chain finality. Alarming on that state alarms constantly.
 *  2. "The desk holds more than its books explain" has innocent and dangerous
 *     causes that look identical from the ledgers alone. The token's own
 *     Transfer log distinguishes them: a mint comes from the zero address.
 */

const EXPECTED_LATENCY = 600; // ten minutes, roughly a testnet lane

async function setUp(expectedLatencySeconds = EXPECTED_LATENCY) {
  const context = await deployWarehouses();
  const publicClient =
    (await context.viem.getPublicClient()) as unknown as PublicClient;
  const clients: BridgeClients = {
    source: publicClient,
    destination: publicClient,
  };
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
    expectedLatencySeconds,
  };
  return { ...context, clients, deployment };
}

/** Ship to an address with no contract, so the message never arrives. */
async function shipIntoTheVoid(context: Awaited<ReturnType<typeof setUp>>) {
  const { viem, outbox, testToken } = context;
  const [, nowhere] = await viem.getWalletClients();

  await dripTokens(viem, testToken, outbox.address, 2);
  await outbox.write.setDestination([
    SEPOLIA_SELECTOR,
    nowhere.account.address,
    true,
  ]);
  await outbox.write.shipCargo([
    SEPOLIA_SELECTOR,
    nowhere.account.address,
    testToken,
    ONE_TOKEN,
    "Pallet 42, one crate",
  ]);
}

describe("A message that has not arrived yet is not a message that is lost", function () {
  it("treats a fresh unsettled message as in flight, not as a fault", async function () {
    const context = await setUp();
    await shipIntoTheVoid(context);

    const report = await reconcile(context.clients, context.deployment);

    // It has not arrived. It is also ten seconds old, on a lane that takes ten
    // minutes. Nothing is wrong yet.
    assert.equal(report.inFlightMessages.length, 1);
    assert.equal(report.unsettledMessages.length, 0);
    assert.equal(report.healthy, true);

    const finding = report.findings.find(
      (candidate) => candidate.code === "MESSAGES_IN_FLIGHT",
    );
    assert.equal(finding?.severity, "info");

    // The gap in the ledger is fully explained by the message in flight, so it
    // is not reported as missing.
    const [ledger] = report.ledgers;
    assert.equal(ledger.unsettled, ONE_TOKEN);
    assert.equal(ledger.inFlight, ONE_TOKEN);
    assert.equal(ledger.missing, 0n);
  });

  it("escalates to a warning once it passes the expected latency", async function () {
    const context = await setUp();
    await shipIntoTheVoid(context);

    await context.networkHelpers.time.increase(EXPECTED_LATENCY + 60);

    const report = await reconcile(context.clients, context.deployment);

    assert.equal(report.healthy, false);
    const finding = report.findings.find(
      (candidate) => candidate.code === "MESSAGE_OVERDUE",
    );
    assert.equal(finding?.severity, "warn");
    assert.equal(report.messages[0].state, "overdue");
  });

  it("escalates to an alarm once it is far past due", async function () {
    const context = await setUp();
    await shipIntoTheVoid(context);

    await context.networkHelpers.time.increase(
      EXPECTED_LATENCY * MISSING_MULTIPLIER + 60,
    );

    const report = await reconcile(context.clients, context.deployment);

    assert.equal(report.healthy, false);
    assert.equal(report.messages[0].state, "missing");

    const missing = report.findings.find(
      (candidate) => candidate.code === "MESSAGE_MISSING",
    );
    assert.equal(missing?.severity, "alarm");

    // Only now is the ledger gap real, rather than latency.
    const gap = report.findings.find(
      (candidate) => candidate.code === "LEDGER_GAP",
    );
    assert.equal(gap?.severity, "alarm");

    const [ledger] = report.ledgers;
    assert.equal(ledger.inFlight, 0n);
    assert.equal(ledger.missing, ONE_TOKEN);
  });

  it("records how old an unsettled message is", async function () {
    const context = await setUp();
    await shipIntoTheVoid(context);
    await context.networkHelpers.time.increase(EXPECTED_LATENCY + 60);

    const report = await reconcile(context.clients, context.deployment);
    const [message] = report.messages;

    assert.ok(message.shippedAt !== undefined);
    assert.ok((message.ageSeconds ?? 0) >= EXPECTED_LATENCY);
  });
});

describe("Telling a donation from a counterfeit", function () {
  const mintableAbi = parseAbi(["function drip(address to)"]);

  it("reports a plain transfer in as unaccounted, but only a warning", async function () {
    const context = await setUp();
    const { viem, inbox, testToken } = context;
    const [donor] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Mint to the donor first, then transfer on. The mint lands on the donor,
    // not on the desk, so the desk's gain arrives as an ordinary transfer.
    await dripTokens(viem, testToken, donor.account.address, 1);
    const hash = await donor.writeContract({
      address: testToken,
      abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]),
      functionName: "transfer",
      args: [inbox.address, ONE_TOKEN],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const report = await reconcile(context.clients, context.deployment);
    const [ledger] = report.ledgers;

    assert.equal(ledger.unaccounted, ONE_TOKEN);
    assert.equal(ledger.unaccountedFromMint, 0n);

    const finding = report.findings.find(
      (candidate) => candidate.code === "UNACCOUNTED_BALANCE",
    );
    assert.equal(finding?.severity, "warn");
    assert.equal(
      report.findings.some((c) => c.code === "UNACCOUNTED_MINT"),
      false,
    );
  });

  it("raises an alarm when the tokens were minted straight to the desk", async function () {
    const context = await setUp();
    const { viem, inbox, testToken } = context;
    const [operator] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();

    // Tokens conjured directly into the desk, with no delivery to explain
    // them. This is what an unbacked mint looks like from the destination.
    const hash = await operator.writeContract({
      address: testToken,
      abi: mintableAbi,
      functionName: "drip",
      args: [inbox.address],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const report = await reconcile(context.clients, context.deployment);
    const [ledger] = report.ledgers;

    assert.equal(ledger.unaccounted, ONE_TOKEN);
    assert.equal(ledger.unaccountedFromMint, ONE_TOKEN);

    const finding = report.findings.find(
      (candidate) => candidate.code === "UNACCOUNTED_MINT",
    );
    assert.equal(finding?.severity, "alarm");
    assert.equal(report.healthy, false);
  });

  it("does not flag mints that arrived as part of a recorded delivery", async function () {
    const context = await setUp();
    const { viem, outbox, inbox, testToken } = context;
    await dripTokens(viem, testToken, outbox.address, 2);

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);

    const report = await reconcile(context.clients, context.deployment);
    const [ledger] = report.ledgers;

    assert.equal(ledger.received, ONE_TOKEN);
    assert.equal(ledger.unaccounted, 0n);
    assert.equal(ledger.unaccountedFromMint, 0n);
    assert.equal(report.healthy, true);
  });
});

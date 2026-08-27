import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAbi, zeroAddress, type Address, type PublicClient } from "viem";
import {
  balanceOf,
  deployWarehouses,
  dripTokens,
  ONE_TOKEN,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";
import { reconcile, type Deployment } from "../src/reconcile.js";
import { readStatus } from "../src/status.js";

const ONE_HOUR = 3600;

const transferAbi = parseAbi([
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/**
 * These tests run the REAL operator tooling - the same functions the CLI calls -
 * against freshly compiled contracts. If an ABI in src/abis.ts drifts from a
 * contract, these fail.
 */
async function setUp(options: { configure?: boolean } = {}) {
  const context = await deployWarehouses(options);
  const client = (await context.viem.getPublicClient()) as unknown as PublicClient;
  const deployment: Deployment = {
    outbox: context.outbox.address as Address,
    inbox: context.inbox.address as Address,
    tokens: [context.testToken as Address],
  };
  return { ...context, client, deployment };
}

describe("Reconciliation: the happy path", function () {
  it("reports healthy when both desks agree", async function () {
    const { viem, client, deployment, outbox, inbox, testToken } = await setUp();
    await dripTokens(viem, testToken, outbox.address, 2);

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);

    const report = await reconcile(client, deployment);

    assert.equal(report.healthy, true);
    assert.equal(report.findings.length, 0);
    assert.equal(report.messages.length, 1);
    assert.equal(report.unsettledMessages.length, 0);

    const [ledger] = report.ledgers;
    assert.equal(ledger.shipped, ONE_TOKEN);
    assert.equal(ledger.received, ONE_TOKEN);
    assert.equal(ledger.unsettled, 0n);
    assert.equal(ledger.unaccounted, 0n);
  });
});

describe("Drill 1: cargo shipped to an address that cannot receive it", function () {
  it("catches the failure CCIP reported as a success", async function () {
    const { viem, client, deployment, outbox, inbox, testToken } = await setUp();
    const [, typo] = await viem.getWalletClients();
    await dripTokens(viem, testToken, outbox.address, 2);

    // The Checkpoint 4 hazard: nothing reverts, nothing errors, no event on the
    // destination. The only trace is the two ledgers disagreeing.
    await outbox.write.setDestination([
      SEPOLIA_SELECTOR,
      typo.account.address,
      true,
    ]);
    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      typo.account.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);

    const report = await reconcile(client, deployment);

    assert.equal(report.healthy, false);
    assert.equal(report.unsettledMessages.length, 1);
    assert.equal(await inbox.read.deliveryCount(), 0n);

    const codes = report.findings.map((finding) => finding.code);
    assert.ok(codes.includes("UNSETTLED_MESSAGE"));
    assert.ok(codes.includes("LEDGER_GAP"));

    // Cargo went missing, so this is an alarm and not merely a warning.
    const unsettled = report.findings.find(
      (finding) => finding.code === "UNSETTLED_MESSAGE",
    );
    assert.equal(unsettled?.severity, "alarm");

    const [ledger] = report.ledgers;
    assert.equal(ledger.shipped, ONE_TOKEN);
    assert.equal(ledger.received, 0n);
    assert.equal(ledger.unsettled, ONE_TOKEN);
    assert.equal(
      await balanceOf(viem, testToken, typo.account.address),
      ONE_TOKEN,
    );
  });
});

describe("Drill 2: tokens arriving without a message", function () {
  it("reports a balance the books cannot explain", async function () {
    const { viem, client, deployment, inbox, testToken } = await setUp();
    const [donor] = await viem.getWalletClients();
    await dripTokens(viem, testToken, donor.account.address, 1);

    // A plain ERC-20 transfer. The inbox's code never runs, so totalReceived
    // stays at zero while the balance moves.
    const publicClient = await viem.getPublicClient();
    const hash = await donor.writeContract({
      address: testToken,
      abi: transferAbi,
      functionName: "transfer",
      args: [inbox.address, ONE_TOKEN],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    const report = await reconcile(client, deployment);

    assert.equal(report.healthy, false);
    const finding = report.findings.find(
      (candidate) => candidate.code === "UNACCOUNTED_BALANCE",
    );
    assert.equal(finding?.severity, "warn");

    const [ledger] = report.ledgers;
    assert.equal(ledger.received, 0n);
    assert.equal(ledger.inboxBalance, ONE_TOKEN);
    assert.equal(ledger.unaccounted, ONE_TOKEN);
  });
});

describe("Drill 3: held cargo nobody released", function () {
  it("flags a hold that has matured and is still sitting there", async function () {
    const { viem, client, deployment, outbox, inbox, networkHelpers, testToken } =
      await setUp();
    await dripTokens(viem, testToken, outbox.address, 5);
    await inbox.write.setLargeTransferThreshold([testToken, ONE_TOKEN * 2n]);
    await inbox.write.setReleaseDelay([BigInt(ONE_HOUR)]);

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN * 3n,
      "a large crate",
    ]);

    // While the hold is running, nothing is wrong.
    let report = await reconcile(client, deployment);
    assert.equal(report.healthy, true);
    assert.equal(report.held.length, 1);
    assert.equal(report.held[0].due, false);

    await networkHelpers.time.increase(ONE_HOUR + 1);

    // Once it matures and stays unreleased, an operator has work to do.
    report = await reconcile(client, deployment);
    assert.equal(report.healthy, false);
    assert.equal(report.held[0].due, true);
    assert.ok(
      report.findings.some((finding) => finding.code === "RELEASE_DUE"),
    );

    await inbox.write.releaseCargo([report.held[0].messageId]);

    report = await reconcile(client, deployment);
    assert.equal(report.healthy, true);
    assert.equal(report.held[0].released, true);
  });
});

describe("Drill 4: an incident in progress", function () {
  it("reports a paused desk without calling it a failure", async function () {
    const { client, deployment, inbox } = await setUp();

    await inbox.write.pause();
    const report = await reconcile(client, deployment);

    assert.equal(report.inboxPaused, true);
    const finding = report.findings.find(
      (candidate) => candidate.code === "INBOX_PAUSED",
    );

    // A pause is a deliberate operator action, not a fault. It is reported so
    // an operator knows why deliveries stopped, but it does not raise an alarm
    // and does not mark the system unhealthy on its own.
    assert.equal(finding?.severity, "info");
    assert.equal(report.healthy, true);
  });
});

describe("Operator status", function () {
  it("reads both desks through the same ABIs the CLI uses", async function () {
    const { viem, client, deployment, outbox, inbox, testToken } = await setUp();
    const [, guardian] = await viem.getWalletClients();

    await outbox.write.setGuardian([guardian.account.address]);
    await outbox.write.setLimit([zeroAddress, true, 5n, BigInt(ONE_HOUR)]);
    await inbox.write.setReleaseDelay([BigInt(ONE_HOUR)]);

    const status = await readStatus(client, deployment);

    assert.equal(
      status.outbox.guardian.toLowerCase(),
      guardian.account.address.toLowerCase(),
    );
    assert.equal(status.outbox.paused, false);
    assert.equal(status.outbox.destinationGasLimit, 600000n);
    assert.equal(status.inbox.releaseDelay, BigInt(ONE_HOUR));

    const deliveries = status.outbox.limits.find(
      (limit) => limit.token === zeroAddress,
    );
    assert.equal(deliveries?.enabled, true);
    assert.equal(deliveries?.amountPerWindow, 5n);
    assert.equal(deliveries?.remaining, 5n);

    // An unconfigured token bucket reports as unlimited.
    const cargo = status.outbox.limits.find((limit) => limit.token === testToken);
    assert.equal(cargo?.enabled, false);
    assert.equal(cargo?.remaining, 2n ** 256n - 1n);
  });
});

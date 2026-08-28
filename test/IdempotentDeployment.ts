import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import type { Address, PublicClient } from "viem";
import {
  decideDeployment,
  hasCode,
  predictDeployment,
  verifyAdopted,
} from "../src/adopt.js";
import {
  converge,
  formatPlan,
  planConvergence,
  type ConfigStep,
} from "../src/converge.js";
import { deployWarehouses, SEPOLIA_SELECTOR } from "../test-support/warehouses.js";

/**
 * Deployment and configuration have to be safe to run twice, because in
 * practice they WILL be run twice: a dropped connection, a closed laptop, a
 * half-failed run someone retries.
 *
 * The dangerous case is narrow and quiet. A deploy transaction lands, the
 * script dies before recording the address, and the next run deploys a second
 * contract. Two desks now exist, one is configured, and reconciliation compares
 * the wrong pair of ledgers while reporting healthy.
 */

describe("Deployment decisions come from the chain, not the file", function () {
  it("adopts a contract that is already recorded and really there", async function () {
    const { viem, outbox } = await deployWarehouses();
    const client = (await viem.getPublicClient()) as unknown as PublicClient;
    const [deployer] = await viem.getWalletClients();

    const decision = await decideDeployment(
      client,
      deployer.account.address as Address,
      { address: outbox.address as Address },
    );

    assert.equal(decision.action, "adopt");
    if (decision.action === "adopt") {
      assert.equal(decision.address, outbox.address);
    }
  });

  it("redeploys when the recorded address has no code", async function () {
    const { viem } = await deployWarehouses();
    const client = (await viem.getPublicClient()) as unknown as PublicClient;
    const [deployer] = await viem.getWalletClients();

    // A record pointing at nothing - a wiped testnet, or a file copied between
    // environments. Trusting it would configure a contract that does not exist.
    const decision = await decideDeployment(
      client,
      deployer.account.address as Address,
      { address: "0x000000000000000000000000000000000000dEaD" },
    );

    assert.equal(decision.action, "deploy");
    assert.match(decision.reason, /no code/);
  });

  it("recovers a deployment whose transaction landed but was never recorded", async function () {
    const { viem } = await deployWarehouses();
    const client = (await viem.getPublicClient()) as unknown as PublicClient;
    const [deployer] = await viem.getWalletClients();
    const deployerAddress = deployer.account.address as Address;

    // Exactly the crash window: predict the address, deploy, and then pretend
    // the process died before anything was written down.
    const pending = await predictDeployment(client, deployerAddress);
    const deployed = await viem.deployContract("WarehouseOutbox", [
      "0x0000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000002",
    ]);

    assert.equal(
      deployed.address.toLowerCase(),
      pending.predictedAddress.toLowerCase(),
      "a CREATE address is knowable before the transaction is sent",
    );

    // The next run has no recorded address, only the pending intent.
    const decision = await decideDeployment(client, deployerAddress, {
      pending,
    });

    assert.equal(decision.action, "adopt");
    if (decision.action === "adopt") {
      assert.equal(
        decision.address.toLowerCase(),
        deployed.address.toLowerCase(),
      );
      assert.match(decision.reason, /interrupted/);
    }
  });

  it("deploys when a pending intent never actually landed", async function () {
    const { viem } = await deployWarehouses();
    const client = (await viem.getPublicClient()) as unknown as PublicClient;
    const [deployer] = await viem.getWalletClients();
    const deployerAddress = deployer.account.address as Address;

    // Intent written, transaction never sent. Nothing is at the predicted
    // address, so the next run must deploy rather than adopt thin air.
    const pending = await predictDeployment(client, deployerAddress);
    assert.equal(await hasCode(client, pending.predictedAddress), false);

    const decision = await decideDeployment(client, deployerAddress, {
      pending,
    });
    assert.equal(decision.action, "deploy");
  });

  it("refuses to adopt something that is not our contract", async function () {
    const { viem, outbox } = await deployWarehouses();

    // Code at an address proves something is there, not that it is ours.
    const check = await verifyAdopted(
      () => outbox.read.router() as Promise<string>,
      "0x000000000000000000000000000000000000dEaD",
      "configured CCIP router",
    );

    assert.equal(check.ok, false);
    assert.match(check.detail, /expected/);
  });
});

describe("Configuration converges instead of replaying", function () {
  /** Desired state for a freshly deployed outbox. */
  async function stepsFor(context: Awaited<ReturnType<typeof deployWarehouses>>) {
    const { outbox, inbox, viem } = context;
    const [, newShipper] = await viem.getWalletClients();

    const steps: ConfigStep[] = [
      {
        description: "shipper allowed",
        desired: true,
        read: () => outbox.read.isShipper([newShipper.account.address]),
        apply: () =>
          outbox.write.setShipper([newShipper.account.address, true]),
      },
      {
        description: "destination allowed",
        desired: true,
        read: () =>
          outbox.read.allowedDestination([SEPOLIA_SELECTOR, inbox.address]),
        apply: () =>
          outbox.write.setDestination([SEPOLIA_SELECTOR, inbox.address, true]),
      },
    ];
    return steps;
  }

  it("applies only what differs, then nothing at all", async function () {
    const context = await deployWarehouses();
    const steps = await stepsFor(context);

    // The destination is already allowlisted by the test fixture; the shipper
    // is not. One step, not two.
    const first = await converge(steps);
    assert.equal(first.applied.length, 1);
    assert.equal(first.applied[0], "shipper allowed");
    assert.equal(first.skipped.length, 1);

    // Converged: a second run sends nothing.
    const second = await converge(steps);
    assert.equal(second.applied.length, 0);
    assert.equal(second.plan.converged, true);
    assert.equal(second.plan.pending, 0);
  });

  it("plans without sending anything", async function () {
    const context = await deployWarehouses();
    const steps = await stepsFor(context);

    const plan = await planConvergence(steps);
    assert.equal(plan.pending, 1);
    assert.equal(plan.converged, false);

    // Planning is read-only, so the state it just described is unchanged.
    const again = await planConvergence(steps);
    assert.equal(again.pending, 1);

    const dry = await converge(steps, { dryRun: true });
    assert.equal(dry.applied.length, 0);
    assert.equal((await planConvergence(steps)).pending, 1);
  });

  it("resumes after a step fails part way through", async function () {
    const context = await deployWarehouses();
    const { outbox, viem } = context;
    const [, shipper] = await viem.getWalletClients();

    let failNext = true;
    const steps: ConfigStep[] = [
      {
        description: "shipper allowed",
        desired: true,
        read: () => outbox.read.isShipper([shipper.account.address]),
        apply: () => outbox.write.setShipper([shipper.account.address, true]),
      },
      {
        description: "token allowed",
        desired: true,
        read: () => outbox.read.allowedToken([context.linkToken]),
        apply: async () => {
          // Stand in for a dropped RPC connection on the second transaction.
          if (failNext) {
            failNext = false;
            throw new Error("connection reset");
          }
          return outbox.write.setToken([context.linkToken, true]);
        },
      },
    ];

    await assert.rejects(converge(steps), /connection reset/);

    // The first step committed. A rerun must not repeat it, and must finish
    // the second.
    const resumed = await converge(steps);
    assert.deepEqual(resumed.applied, ["token allowed"]);
    assert.deepEqual(resumed.skipped, ["shipper allowed"]);

    assert.equal((await planConvergence(steps)).converged, true);
  });

  it("treats an unreadable step as needing a change rather than skipping it", async function () {
    const steps: ConfigStep[] = [
      {
        description: "something we cannot read",
        desired: true,
        read: async () => {
          throw new Error("node unreachable");
        },
        apply: async () => undefined,
      },
    ];

    const plan = await planConvergence(steps);

    // Silently doing nothing is the failure this module exists to prevent.
    assert.equal(plan.pending, 1);
    assert.match(String(plan.steps[0].actual), /unreadable/);
  });

  it("renders a plan a human can check before it runs", async function () {
    const context = await deployWarehouses();
    const steps = await stepsFor(context);

    const text = formatPlan(await planConvergence(steps));

    assert.match(text, /shipper allowed/);
    assert.match(text, /1 of 2 steps need a transaction/);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbiParameters,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  BASE_SEPOLIA_SELECTOR,
  deployWarehouses,
  dripTokens,
  ONE_TOKEN,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";

/**
 * Two problems found by reading the contracts against how Chainlink's own
 * limiter and admin tooling work:
 *
 *  1. A fixed window resets. Spend the whole budget just before the boundary
 *     and again just after, and twice the intended rate passes in seconds. A
 *     token bucket has no boundary to exploit.
 *  2. One key could both widen trust and move funds. Splitting the powers and
 *     delaying only the widening ones turns a stolen key from an instant loss
 *     into a scheduled, visible, cancellable event.
 */

const ONE_HOUR = 3600;

const budget = (capacity: bigint, refillAmount: bigint, refillPeriod: bigint) =>
  ({ enabled: true, capacity, refillAmount, refillPeriod }) as const;

/** The id the contract derives for a call: keccak256(abi.encode(this, msg.data)). */
function actionId(contract: Address, callData: Hex): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, bytes"), [
      contract,
      callData,
    ]),
  );
}

describe("The window boundary is gone", function () {
  it("refills continuously instead of resetting", async function () {
    const { viem, outbox, inbox, networkHelpers } = await deployWarehouses();

    // Two deliveries an hour.
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(2n, 2n, BigInt(ONE_HOUR)),
    ]);

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "one"]);
    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "two"]);
    assert.equal(
      await outbox.read.remainingAllowance([SEPOLIA_SELECTOR, zeroAddress]),
      0n,
    );

    // Just short of a full period. The old fixed window would have reset here
    // on the next second and handed back the entire budget, letting four
    // deliveries through in barely over an hour. A bucket has refilled by one.
    await networkHelpers.time.increase(ONE_HOUR - 5);

    assert.equal(
      await outbox.read.remainingAllowance([SEPOLIA_SELECTOR, zeroAddress]),
      1n,
    );

    await viem.assertions.revertWithCustomError(
      outbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        zeroAddress,
        2n,
        "two at once",
      ]),
      outbox,
      "TokenNotAllowed",
    );

    // One fits; the second does not.
    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "three"]);
    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "four"]),
      outbox,
      "RateLimitExceeded",
    );
  });

  it("grants a partial refill part-way through a period", async function () {
    const { outbox, inbox, networkHelpers } = await deployWarehouses();
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(4n, 4n, BigInt(ONE_HOUR)),
    ]);

    for (const note of ["a", "b", "c", "d"]) {
      await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, note]);
    }
    assert.equal(
      await outbox.read.remainingAllowance([SEPOLIA_SELECTOR, zeroAddress]),
      0n,
    );

    // Half a period restores half the budget, rather than nothing.
    await networkHelpers.time.increase(ONE_HOUR / 2);
    assert.equal(
      await outbox.read.remainingAllowance([SEPOLIA_SELECTOR, zeroAddress]),
      2n,
    );
  });

  it("never accrues past its capacity, however long it idles", async function () {
    const { outbox, networkHelpers } = await deployWarehouses();
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(2n, 2n, BigInt(ONE_HOUR)),
    ]);

    await networkHelpers.time.increase(ONE_HOUR * 10);

    // Ten hours of refill, still capped at the burst capacity.
    assert.equal(
      await outbox.read.remainingAllowance([SEPOLIA_SELECTOR, zeroAddress]),
      2n,
    );
  });
});

describe("Limits are scoped to a lane", function () {
  it("does not let one lane spend another lane's budget", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();

    await outbox.write.setDestination([
      BASE_SEPOLIA_SELECTOR,
      inbox.address,
      true,
    ]);
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(1n, 1n, BigInt(ONE_HOUR)),
    ]);
    await outbox.write.setLimit([
      BASE_SEPOLIA_SELECTOR,
      zeroAddress,
      budget(1n, 1n, BigInt(ONE_HOUR)),
    ]);

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "one"]);

    // The Sepolia lane is spent...
    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "two"]),
      outbox,
      "RateLimitExceeded",
    );

    // ...and the Base lane is untouched.
    assert.equal(
      await outbox.read.remainingAllowance([BASE_SEPOLIA_SELECTOR, zeroAddress]),
      1n,
    );
    await outbox.write.shipDelivery([
      BASE_SEPOLIA_SELECTOR,
      inbox.address,
      "other lane",
    ]);
  });

  it("bounds the total across every lane with the aggregate bucket", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();
    const ALL_LANES = 0n;

    await outbox.write.setDestination([
      BASE_SEPOLIA_SELECTOR,
      inbox.address,
      true,
    ]);
    // Generous per lane, strict overall.
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(5n, 5n, BigInt(ONE_HOUR)),
    ]);
    await outbox.write.setLimit([
      BASE_SEPOLIA_SELECTOR,
      zeroAddress,
      budget(5n, 5n, BigInt(ONE_HOUR)),
    ]);
    await outbox.write.setLimit([
      ALL_LANES,
      zeroAddress,
      budget(1n, 1n, BigInt(ONE_HOUR)),
    ]);

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "one"]);

    // The second lane still has its own full budget - only the Sepolia lane
    // and the aggregate were spent - but the aggregate is what stops it.
    assert.equal(
      await outbox.read.remainingAllowance([BASE_SEPOLIA_SELECTOR, zeroAddress]),
      5n,
    );
    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([
        BASE_SEPOLIA_SELECTOR,
        inbox.address,
        "two",
      ]),
      outbox,
      "RateLimitExceeded",
    );
  });
});

describe("Separated powers", function () {
  it("does not let a config admin move funds", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    const [operator, configAdmin] = await viem.getWalletClients();
    await dripTokens(viem, testToken, outbox.address, 1);
    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "a crate",
    ]);

    const CONFIG_ROLE = await inbox.read.CONFIG_ROLE();
    await inbox.write.setRole([CONFIG_ROLE, configAdmin.account.address, true]);

    // It can change who is trusted...
    await inbox.write.setSourceWarehouse(
      [SEPOLIA_SELECTOR, operator.account.address, true],
      { account: configAdmin.account },
    );

    // ...and it cannot take anything.
    await viem.assertions.revertWithCustomError(
      inbox.write.withdrawCargo(
        [testToken, configAdmin.account.address, ONE_TOKEN],
        { account: configAdmin.account },
      ),
      inbox,
      "MissingRole",
    );
  });

  it("does not let a treasurer decide who is trusted", async function () {
    const { viem, inbox } = await deployWarehouses();
    const [, treasurer, stranger] = await viem.getWalletClients();

    const TREASURY_ROLE = await inbox.read.TREASURY_ROLE();
    await inbox.write.setRole([TREASURY_ROLE, treasurer.account.address, true]);

    await viem.assertions.revertWithCustomError(
      inbox.write.setSourceWarehouse(
        [SEPOLIA_SELECTOR, stranger.account.address, true],
        { account: treasurer.account },
      ),
      inbox,
      "MissingRole",
    );
  });

  it("gives the owner no implicit bypass of the treasury role", async function () {
    const { viem, outbox, inbox, operator, testToken } = await deployWarehouses();
    await dripTokens(viem, testToken, outbox.address, 1);
    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "a crate",
    ]);

    // The deployer is the owner and starts with every role. Take the treasury
    // role away and the owner can no longer withdraw: it has to grant itself
    // the role again, which is a widening change and therefore visible.
    const TREASURY_ROLE = await inbox.read.TREASURY_ROLE();
    await inbox.write.setRole([TREASURY_ROLE, operator.account.address, false]);

    await viem.assertions.revertWithCustomError(
      inbox.write.withdrawCargo([
        testToken,
        operator.account.address,
        ONE_TOKEN,
      ]),
      inbox,
      "MissingRole",
    );
  });

  it("hands ownership over in two steps", async function () {
    const { viem, outbox, operator } = await deployWarehouses();
    const [, nextOwner, stranger] = await viem.getWalletClients();

    await outbox.write.transferOwnership([nextOwner.account.address]);

    // Nothing has changed yet.
    assert.equal(
      (await outbox.read.owner()).toLowerCase(),
      operator.account.address.toLowerCase(),
    );
    assert.equal(
      (await outbox.read.pendingOwner()).toLowerCase(),
      nextOwner.account.address.toLowerCase(),
    );

    await viem.assertions.revertWithCustomError(
      outbox.write.acceptOwnership({ account: stranger.account }),
      outbox,
      "OwnableUnauthorizedAccount",
    );

    await outbox.write.acceptOwnership({ account: nextOwner.account });
    assert.equal(
      (await outbox.read.owner()).toLowerCase(),
      nextOwner.account.address.toLowerCase(),
    );
  });
});

describe("Widening waits, tightening does not", function () {
  async function withDelay() {
    const context = await deployWarehouses();
    // Raising the delay is tightening, so it applies immediately.
    await context.inbox.write.setTrustDelay([BigInt(ONE_HOUR)]);
    return context;
  }

  it("refuses to widen trust without a scheduled action", async function () {
    const { viem, inbox } = await withDelay();
    const [, stranger] = await viem.getWalletClients();

    await viem.assertions.revertWithCustomError(
      inbox.write.setSourceWarehouse([
        SEPOLIA_SELECTOR,
        stranger.account.address,
        true,
      ]),
      inbox,
      "ActionNotScheduled",
    );
  });

  it("still revokes trust immediately", async function () {
    const { inbox, outbox } = await withDelay();

    // The outbox was allowlisted during setup, before the delay existed.
    await inbox.write.setSourceWarehouse([
      SEPOLIA_SELECTOR,
      outbox.address,
      false,
    ]);

    assert.equal(
      await inbox.read.allowedSourceWarehouse([
        SEPOLIA_SELECTOR,
        outbox.address,
      ]),
      false,
    );
  });

  it("waits out the delay, then executes exactly the scheduled call", async function () {
    const { viem, inbox, networkHelpers } = await withDelay();
    const [, stranger] = await viem.getWalletClients();

    const callData = encodeFunctionData({
      abi: inbox.abi,
      functionName: "setSourceWarehouse",
      args: [SEPOLIA_SELECTOR, stranger.account.address, true],
    });
    const id = actionId(inbox.address, callData);

    await inbox.write.scheduleAction([id]);

    // Announced, but not yet ripe.
    await viem.assertions.revertWithCustomError(
      inbox.write.setSourceWarehouse([
        SEPOLIA_SELECTOR,
        stranger.account.address,
        true,
      ]),
      inbox,
      "ActionNotReady",
    );

    await networkHelpers.time.increase(ONE_HOUR + 1);

    await inbox.write.setSourceWarehouse([
      SEPOLIA_SELECTOR,
      stranger.account.address,
      true,
    ]);
    assert.equal(
      await inbox.read.allowedSourceWarehouse([
        SEPOLIA_SELECTOR,
        stranger.account.address,
      ]),
      true,
    );

    // The schedule is consumed, so the same widening cannot be replayed.
    assert.equal(await inbox.read.scheduled([id]), 0n);
  });

  it("lets a guardian cancel a widening before it matures", async function () {
    const { viem, inbox, networkHelpers } = await deployWarehouses();
    const [, guardian, attacker] = await viem.getWalletClients();

    // Appoint the guardian BEFORE raising the delay: granting a role is itself
    // a widening change, so afterwards it would need scheduling too.
    const GUARDIAN_ROLE = await inbox.read.GUARDIAN_ROLE();
    await inbox.write.setRole([GUARDIAN_ROLE, guardian.account.address, true]);
    await inbox.write.setTrustDelay([BigInt(ONE_HOUR)]);

    const callData = encodeFunctionData({
      abi: inbox.abi,
      functionName: "setSourceWarehouse",
      args: [SEPOLIA_SELECTOR, attacker.account.address, true],
    });
    const id = actionId(inbox.address, callData);

    await inbox.write.scheduleAction([id]);
    await inbox.write.cancelAction([id], { account: guardian.account });

    await networkHelpers.time.increase(ONE_HOUR + 1);

    // The delay expired, but the schedule is gone.
    await viem.assertions.revertWithCustomError(
      inbox.write.setSourceWarehouse([
        SEPOLIA_SELECTOR,
        attacker.account.address,
        true,
      ]),
      inbox,
      "ActionNotScheduled",
    );
  });

  it("delays raising a limit but not lowering one", async function () {
    const { viem, outbox } = await deployWarehouses();
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(5n, 5n, BigInt(ONE_HOUR)),
    ]);
    await outbox.write.setTrustDelay([BigInt(ONE_HOUR)]);

    // Tightening the cap needs no announcement.
    await outbox.write.setLimit([
      SEPOLIA_SELECTOR,
      zeroAddress,
      budget(2n, 2n, BigInt(ONE_HOUR)),
    ]);

    // Raising it does.
    await viem.assertions.revertWithCustomError(
      outbox.write.setLimit([
        SEPOLIA_SELECTOR,
        zeroAddress,
        budget(100n, 100n, BigInt(ONE_HOUR)),
      ]),
      outbox,
      "ActionNotScheduled",
    );

    // And so does removing it altogether: an unconfigured limit is unlimited.
    await viem.assertions.revertWithCustomError(
      outbox.write.setLimit([
        SEPOLIA_SELECTOR,
        zeroAddress,
        { enabled: false, capacity: 0n, refillAmount: 0n, refillPeriod: 0n },
      ]),
      outbox,
      "ActionNotScheduled",
    );
  });
});

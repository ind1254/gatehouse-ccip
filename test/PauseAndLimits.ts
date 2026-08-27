import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeErrorResult, keccak256, toHex, zeroAddress } from "viem";
import {
  assertRevertedInsideReceiver,
  balanceOf,
  deliverAsRouter,
  deployWarehouses,
  dripTokens,
  ONE_TOKEN,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";

const ONE_HOUR = 3600;

describe("Emergency pause", function () {
  it("lets the guardian stop new shipments immediately", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();
    const [, guardian] = await viem.getWalletClients();

    await outbox.write.setGuardian([guardian.account.address]);
    await outbox.write.pause({ account: guardian.account });

    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([
        SEPOLIA_SELECTOR,
        inbox.address,
        "Pallet 42 released",
      ]),
      outbox,
      "EnforcedPause",
    );

    assert.equal(await inbox.read.deliveryCount(), 0n);
  });

  it("does not let the guardian restart the bridge", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();
    const [, guardian] = await viem.getWalletClients();

    await outbox.write.setGuardian([guardian.account.address]);
    await outbox.write.pause({ account: guardian.account });

    // Stopping is a reflex. Restarting is a decision, and it stays with the
    // owner.
    await viem.assertions.revertWithCustomError(
      outbox.write.unpause({ account: guardian.account }),
      outbox,
      "OwnableUnauthorizedAccount",
    );

    await outbox.write.unpause();
    await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);
    assert.equal(await inbox.read.deliveryCount(), 1n);
  });

  it("refuses a stranger at the emergency stop", async function () {
    const { viem, outbox } = await deployWarehouses();
    const [, stranger] = await viem.getWalletClients();

    await viem.assertions.revertWithCustomError(
      outbox.write.pause({ account: stranger.account }),
      outbox,
      "NotGuardianOrOwner",
    );
  });

  it("consumes nothing when a paused inbox refuses a delivery", async function () {
    const { viem, inbox, outbox, networkHelpers, destinationRouter } =
      await deployWarehouses();
    const messageId = keccak256(toHex("delivery-during-incident"));

    await inbox.write.pause();

    await viem.assertions.revertWithCustomError(
      deliverAsRouter(networkHelpers, inbox, destinationRouter, {
        messageId,
        sourceChainSelector: SEPOLIA_SELECTOR,
        sender: outbox.address,
        text: "Pallet 42 released",
      }),
      inbox,
      "EnforcedPause",
    );

    // The revert rolled the whole delivery back, so the messageId was never
    // burned and the same message can land once the incident is over.
    assert.equal(await inbox.read.processedMessages([messageId]), false);
    assert.equal(await inbox.read.deliveryCount(), 0n);

    await inbox.write.unpause();
    await deliverAsRouter(networkHelpers, inbox, destinationRouter, {
      messageId,
      sourceChainSelector: SEPOLIA_SELECTOR,
      sender: outbox.address,
      text: "Pallet 42 released",
    });

    assert.equal(await inbox.read.processedMessages([messageId]), true);
    assert.equal(await inbox.read.deliveryCount(), 1n);
  });
});

describe("Rate limits", function () {
  it("caps how many deliveries fit in one window", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();

    // Two deliveries an hour, counted in the zero-address bucket.
    await outbox.write.setLimit([zeroAddress, true, 2n, BigInt(ONE_HOUR)]);

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "one"]);
    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "two"]);

    // This is the answer to the fifty-message loop: every message is valid,
    // and the budget still runs out.
    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "three"]),
      outbox,
      "RateLimitExceeded",
    );

    assert.equal(await inbox.read.deliveryCount(), 2n);
  });

  it("refills the budget when the window rolls", async function () {
    const { viem, outbox, inbox, networkHelpers } = await deployWarehouses();
    await outbox.write.setLimit([zeroAddress, true, 2n, BigInt(ONE_HOUR)]);

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "one"]);
    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "two"]);
    assert.equal(await outbox.read.remainingAllowance([zeroAddress]), 0n);

    await networkHelpers.time.increase(ONE_HOUR + 1);

    assert.equal(await outbox.read.remainingAllowance([zeroAddress]), 2n);
    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "three"]);
    assert.equal(await inbox.read.deliveryCount(), 3n);
  });

  it("caps how much cargo leaves in one window", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    await dripTokens(viem, testToken, outbox.address, 5);
    await outbox.write.setLimit([testToken, true, ONE_TOKEN * 2n, BigInt(ONE_HOUR)]);

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN * 2n,
      "the whole budget",
    ]);

    await viem.assertions.revertWithCustomError(
      outbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        testToken,
        ONE_TOKEN,
        "one too many",
      ]),
      outbox,
      "RateLimitExceeded",
    );

    assert.equal(await balanceOf(viem, testToken, inbox.address), ONE_TOKEN * 2n);
  });

  it("bounds a compromised but still-allowlisted sender at the inbox", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();

    // The outbox is trusted and unlimited. The inbox limits it anyway.
    await inbox.write.setLimit([zeroAddress, true, 1n, BigInt(ONE_HOUR)]);

    await outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "one"]);

    await assertRevertedInsideReceiver(
      outbox.write.shipDelivery([SEPOLIA_SELECTOR, inbox.address, "two"]),
      encodeErrorResult({
        abi: inbox.abi,
        errorName: "RateLimitExceeded",
        args: [zeroAddress, 1n, 1n, 1n],
      }),
    );

    assert.equal(await inbox.read.deliveryCount(), 1n);
  });

  it("treats an unconfigured limit as no limit", async function () {
    const { outbox, testToken } = await deployWarehouses();
    const unlimited = 2n ** 256n - 1n;

    assert.equal(await outbox.read.remainingAllowance([testToken]), unlimited);
    assert.equal(await outbox.read.remainingAllowance([zeroAddress]), unlimited);
  });
});

describe("Large-transfer delay", function () {
  async function setUpHold() {
    const context = await deployWarehouses();
    const { viem, outbox, inbox, testToken } = context;

    await dripTokens(viem, testToken, outbox.address, 5);
    await inbox.write.setLargeTransferThreshold([testToken, ONE_TOKEN * 2n]);
    await inbox.write.setReleaseDelay([BigInt(ONE_HOUR)]);

    return context;
  }

  it("settles a small delivery immediately", async function () {
    const { outbox, inbox, testToken } = await setUpHold();

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "below the threshold",
    ]);

    assert.equal(await inbox.read.totalReceived([testToken]), ONE_TOKEN);
    assert.equal(await inbox.read.totalHeld([testToken]), 0n);
    assert.equal(await inbox.read.withdrawableCargo([testToken]), ONE_TOKEN);
  });

  it("holds a large delivery and refuses to settle it early", async function () {
    const { viem, outbox, inbox, testToken } = await setUpHold();

    const hash = await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN * 3n,
      "at the threshold",
    ]);
    const publicClient = await viem.getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash });
    const messageId = await inbox.read.lastMessageId();

    // The tokens are here. They just do not count yet.
    assert.equal(
      await balanceOf(viem, testToken, inbox.address),
      ONE_TOKEN * 3n,
    );
    assert.equal(await inbox.read.totalHeld([testToken]), ONE_TOKEN * 3n);
    assert.equal(await inbox.read.totalReceived([testToken]), 0n);
    assert.equal(await inbox.read.withdrawableCargo([testToken]), 0n);

    await viem.assertions.revertWithCustomError(
      inbox.write.releaseCargo([messageId]),
      inbox,
      "StillHeld",
    );

    // And the owner cannot reach around the delay by withdrawing the tokens.
    await viem.assertions.revertWithCustomError(
      inbox.write.withdrawCargo([
        testToken,
        (await viem.getWalletClients())[0].account.address,
        ONE_TOKEN,
      ]),
      inbox,
      "CargoNotSettled",
    );
  });

  it("releases held cargo once the delay expires, for anyone who asks", async function () {
    const { viem, outbox, inbox, networkHelpers, testToken } =
      await setUpHold();
    const [, stranger] = await viem.getWalletClients();

    const hash = await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN * 3n,
      "at the threshold",
    ]);
    const publicClient = await viem.getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash });
    const messageId = await inbox.read.lastMessageId();

    await networkHelpers.time.increase(ONE_HOUR + 1);

    // Releasing is the passage of time, not a privilege.
    await inbox.write.releaseCargo([messageId], { account: stranger.account });

    assert.equal(await inbox.read.totalHeld([testToken]), 0n);
    assert.equal(await inbox.read.totalReceived([testToken]), ONE_TOKEN * 3n);
    assert.equal(
      await inbox.read.withdrawableCargo([testToken]),
      ONE_TOKEN * 3n,
    );

    await viem.assertions.revertWithCustomError(
      inbox.write.releaseCargo([messageId]),
      inbox,
      "AlreadyReleased",
    );
  });

  it("freezes held cargo while the desk is paused", async function () {
    const { viem, outbox, inbox, networkHelpers, testToken } =
      await setUpHold();

    const hash = await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN * 3n,
      "at the threshold",
    ]);
    const publicClient = await viem.getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash });
    const messageId = await inbox.read.lastMessageId();

    await inbox.write.pause();
    await networkHelpers.time.increase(ONE_HOUR + 1);

    // The delay has expired, but the incident has not. In-flight value stays
    // exactly where it is: not settled, not withdrawable, not lost.
    await viem.assertions.revertWithCustomError(
      inbox.write.releaseCargo([messageId]),
      inbox,
      "EnforcedPause",
    );
    assert.equal(await inbox.read.totalHeld([testToken]), ONE_TOKEN * 3n);
    assert.equal(await inbox.read.withdrawableCargo([testToken]), 0n);

    await inbox.write.unpause();
    await inbox.write.releaseCargo([messageId]);
    assert.equal(await inbox.read.totalReceived([testToken]), ONE_TOKEN * 3n);
  });
});

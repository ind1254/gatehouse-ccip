import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeErrorResult, keccak256, toHex } from "viem";
import {
  assertRevertedInsideReceiver,
  BASE_SEPOLIA_SELECTOR,
  deliverAsRouter,
  deployWarehouses,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";

describe("Source allowlist", function () {
  it("refuses a rogue warehouse, even though the real router delivered it", async function () {
    const { viem, inbox, outbox, operator, sourceRouter, linkToken } =
      await deployWarehouses();

    // The attack from Checkpoint 2: a second contract, on a chain CCIP
    // supports, shipping through the legitimate router.
    const rogueOutbox = await viem.deployContract("WarehouseOutbox", [
      sourceRouter,
      linkToken,
    ]);
    await rogueOutbox.write.setShipper([operator.account.address, true]);
    await rogueOutbox.write.setDestination([
      SEPOLIA_SELECTOR,
      inbox.address,
      true,
    ]);

    // The rogue desk is happy to ship. The inbox is what stops it.
    await assertRevertedInsideReceiver(
      rogueOutbox.write.shipDelivery([
        SEPOLIA_SELECTOR,
        inbox.address,
        "Release 1,000 tokens to the attacker",
      ]),
      encodeErrorResult({
        abi: inbox.abi,
        errorName: "SourceNotAllowed",
        args: [SEPOLIA_SELECTOR, rogueOutbox.address],
      }),
    );
    assert.equal(await inbox.read.deliveryCount(), 0n);

    // The allowlisted desk still works.
    await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);
    assert.equal(await inbox.read.deliveryCount(), 1n);
  });

  it("names the rejected source when the router speaks to it directly", async function () {
    const { viem, inbox, networkHelpers, destinationRouter } =
      await deployWarehouses();
    const [, stranger] = await viem.getWalletClients();

    await viem.assertions.revertWithCustomError(
      deliverAsRouter(networkHelpers, inbox, destinationRouter, {
        messageId: keccak256(toHex("rogue-1")),
        sourceChainSelector: SEPOLIA_SELECTOR,
        sender: stranger.account.address,
        text: "Release 1,000 tokens to the attacker",
      }),
      inbox,
      "SourceNotAllowed",
    );

    assert.equal(await inbox.read.deliveryCount(), 0n);
  });

  it("refuses a trusted warehouse arriving from the wrong chain", async function () {
    const { viem, inbox, outbox, networkHelpers, destinationRouter } =
      await deployWarehouses();

    // outbox is allowlisted for Sepolia. The same address on another chain is
    // a different principal, and the pair-keyed allowlist knows it.
    await viem.assertions.revertWithCustomError(
      deliverAsRouter(networkHelpers, inbox, destinationRouter, {
        messageId: keccak256(toHex("wrong-chain")),
        sourceChainSelector: BASE_SEPOLIA_SELECTOR,
        sender: outbox.address,
        text: "Pallet 42 released",
      }),
      inbox,
      "SourceNotAllowed",
    );

    assert.equal(await inbox.read.deliveryCount(), 0n);
  });

  it("lets the owner revoke a warehouse it previously trusted", async function () {
    const { viem, inbox, outbox } = await deployWarehouses();

    await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);
    assert.equal(await inbox.read.deliveryCount(), 1n);

    await inbox.write.setSourceWarehouse([
      SEPOLIA_SELECTOR,
      outbox.address,
      false,
    ]);

    await assertRevertedInsideReceiver(
      outbox.write.shipDelivery([
        SEPOLIA_SELECTOR,
        inbox.address,
        "Pallet 43 released",
      ]),
      encodeErrorResult({
        abi: inbox.abi,
        errorName: "SourceNotAllowed",
        args: [SEPOLIA_SELECTOR, outbox.address],
      }),
    );
    assert.equal(await inbox.read.deliveryCount(), 1n);
  });
});

describe("Replay protection", function () {
  it("acts on a messageId once and refuses it forever after", async function () {
    const { viem, inbox, outbox, networkHelpers, destinationRouter } =
      await deployWarehouses();
    const messageId = keccak256(toHex("delivery-1"));

    await deliverAsRouter(networkHelpers, inbox, destinationRouter, {
      messageId,
      sourceChainSelector: SEPOLIA_SELECTOR,
      sender: outbox.address,
      text: "Pallet 42 released",
    });

    assert.equal(await inbox.read.deliveryCount(), 1n);
    assert.equal(await inbox.read.processedMessages([messageId]), true);

    await viem.assertions.revertWithCustomError(
      deliverAsRouter(networkHelpers, inbox, destinationRouter, {
        messageId,
        sourceChainSelector: SEPOLIA_SELECTOR,
        sender: outbox.address,
        text: "Pallet 42 released",
      }),
      inbox,
      "MessageAlreadyProcessed",
    );

    assert.equal(await inbox.read.deliveryCount(), 1n);
  });

  it("still accepts a different messageId carrying the same words", async function () {
    const { inbox, outbox, networkHelpers, destinationRouter } =
      await deployWarehouses();

    for (const id of ["delivery-1", "delivery-2"]) {
      await deliverAsRouter(networkHelpers, inbox, destinationRouter, {
        messageId: keccak256(toHex(id)),
        sourceChainSelector: SEPOLIA_SELECTOR,
        sender: outbox.address,
        text: "Pallet 42 released",
      });
    }

    assert.equal(await inbox.read.deliveryCount(), 2n);
  });
});

describe("Shipping desk access control", function () {
  it("refuses a stranger who is not an authorised shipper", async function () {
    const { viem, inbox, outbox } = await deployWarehouses();
    const [, stranger] = await viem.getWalletClients();

    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery(
        [SEPOLIA_SELECTOR, inbox.address, "Pallet 42 released"],
        { account: stranger.account },
      ),
      outbox,
      "NotAShipper",
    );

    assert.equal(await outbox.read.shippedCount(), 0n);
  });

  it("refuses a shipper aiming at an unapproved receiving desk", async function () {
    const { viem, outbox } = await deployWarehouses();
    const [, stranger] = await viem.getWalletClients();

    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([
        SEPOLIA_SELECTOR,
        stranger.account.address,
        "Pallet 42 released",
      ]),
      outbox,
      "DestinationNotAllowed",
    );

    assert.equal(await outbox.read.shippedCount(), 0n);
  });
});

describe("Ownership of the allowlists", function () {
  it("lets only the owner change who is trusted", async function () {
    const { viem, inbox, outbox } = await deployWarehouses();
    const [, stranger] = await viem.getWalletClients();

    await viem.assertions.revertWithCustomError(
      inbox.write.setSourceWarehouse(
        [SEPOLIA_SELECTOR, stranger.account.address, true],
        { account: stranger.account },
      ),
      inbox,
      "OwnableUnauthorizedAccount",
    );

    await viem.assertions.revertWithCustomError(
      outbox.write.setShipper([stranger.account.address, true], {
        account: stranger.account,
      }),
      outbox,
      "OwnableUnauthorizedAccount",
    );

    assert.equal(
      await inbox.read.allowedSourceWarehouse([
        SEPOLIA_SELECTOR,
        stranger.account.address,
      ]),
      false,
    );
    assert.equal(await outbox.read.isShipper([stranger.account.address]), false);
  });
});

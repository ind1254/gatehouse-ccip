import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeErrorResult, getAddress } from "viem";
import {
  assertRevertedInsideReceiver,
  balanceOf,
  deployWarehouses,
  dripTokens,
  ONE_TOKEN,
  SEPOLIA_SELECTOR,
  totalSupplyOf,
} from "../test-support/warehouses.js";

describe("Cargo transfer", function () {
  it("carries tokens along with the message", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    await dripTokens(viem, testToken, outbox.address, 3);

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);

    assert.equal(await balanceOf(viem, testToken, inbox.address), ONE_TOKEN);
    assert.equal(
      await balanceOf(viem, testToken, outbox.address),
      ONE_TOKEN * 2n,
    );

    // The note travelled with the cargo.
    assert.equal(await inbox.read.lastMessage(), "Pallet 42, one crate");
    assert.equal(await inbox.read.deliveryCount(), 1n);

    // Both desks agree on what moved.
    assert.equal(await outbox.read.totalShipped([testToken]), ONE_TOKEN);
    assert.equal(await inbox.read.totalReceived([testToken]), ONE_TOKEN);
    assert.equal(
      getAddress(await inbox.read.lastCargoToken()),
      getAddress(testToken),
    );
    assert.equal(await inbox.read.lastCargoAmount(), ONE_TOKEN);
  });

  it("conserves the token supply across the transfer", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    await dripTokens(viem, testToken, outbox.address, 3);

    const supplyBefore = await totalSupplyOf(viem, testToken);
    const heldBefore =
      (await balanceOf(viem, testToken, outbox.address)) +
      (await balanceOf(viem, testToken, inbox.address));

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);

    const supplyAfter = await totalSupplyOf(viem, testToken);
    const heldAfter =
      (await balanceOf(viem, testToken, outbox.address)) +
      (await balanceOf(viem, testToken, inbox.address));

    // Nothing was created and nothing was destroyed: the tokens only moved.
    assert.equal(supplyAfter, supplyBefore);
    assert.equal(heldAfter, heldBefore);
  });

  it("keeps totalReceived in step with the desk's real balance", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    await dripTokens(viem, testToken, outbox.address, 3);

    for (const note of ["crate 1", "crate 2", "crate 3"]) {
      await outbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        testToken,
        ONE_TOKEN,
        note,
      ]);
    }

    const booked = await inbox.read.totalReceived([testToken]);
    const held = await inbox.read.cargoBalance([testToken]);

    assert.equal(booked, ONE_TOKEN * 3n);
    assert.equal(held, booked);
    assert.equal(await outbox.read.totalShipped([testToken]), booked);
  });
});

describe("Cargo guardrails", function () {
  it("refuses a token that is not on the allowlist", async function () {
    const { viem, outbox, inbox, linkToken } = await deployWarehouses();

    await viem.assertions.revertWithCustomError(
      outbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        linkToken, // the fee token, never allowlisted as cargo
        ONE_TOKEN,
        "not cargo",
      ]),
      outbox,
      "TokenNotAllowed",
    );
  });

  it("refuses to ship more cargo than the desk holds", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    await dripTokens(viem, testToken, outbox.address, 1);

    await viem.assertions.revertWithCustomError(
      outbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        testToken,
        ONE_TOKEN * 2n,
        "more than we have",
      ]),
      outbox,
      "NotEnoughCargo",
    );

    assert.equal(await balanceOf(viem, testToken, outbox.address), ONE_TOKEN);
    assert.equal(await balanceOf(viem, testToken, inbox.address), 0n);
  });

  it("refuses a zero-amount shipment", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();

    await viem.assertions.revertWithCustomError(
      outbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        testToken,
        0n,
        "empty crate",
      ]),
      outbox,
      "ZeroCargoAmount",
    );
  });
});

describe("Cargo and the three gates", function () {
  it("moves no tokens when the inbox refuses the delivery", async function () {
    const { viem, outbox, inbox, operator, sourceRouter, linkToken, testToken } =
      await deployWarehouses();

    // A rogue desk, fully funded and fully configured on its own side, but
    // never allowlisted by the inbox.
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
    await rogueOutbox.write.setToken([testToken, true]);
    await dripTokens(viem, testToken, rogueOutbox.address, 2);

    await assertRevertedInsideReceiver(
      rogueOutbox.write.shipCargo([
        SEPOLIA_SELECTOR,
        inbox.address,
        testToken,
        ONE_TOKEN,
        "Release the crates to the attacker",
      ]),
      encodeErrorResult({
        abi: inbox.abi,
        errorName: "SourceNotAllowed",
        args: [SEPOLIA_SELECTOR, rogueOutbox.address],
      }),
    );

    // The revert unwound the token transfer along with everything else.
    assert.equal(
      await balanceOf(viem, testToken, rogueOutbox.address),
      ONE_TOKEN * 2n,
    );
    assert.equal(await balanceOf(viem, testToken, inbox.address), 0n);
    assert.equal(await inbox.read.totalReceived([testToken]), 0n);
    assert.equal(await rogueOutbox.read.totalShipped([testToken]), 0n);

    // The allowlisted desk can still ship.
    await dripTokens(viem, testToken, outbox.address, 1);
    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);
    assert.equal(await balanceOf(viem, testToken, inbox.address), ONE_TOKEN);
  });
});

describe("The hazard the destination allowlist exists for", function () {
  it("silently strands cargo sent to an address with no contract code", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    const [, typo] = await viem.getWalletClients();
    await dripTokens(viem, testToken, outbox.address, 1);

    // Pretend the allowlist was never added and a wrong address slipped
    // through. CCIP skips the receiver call when the address has no code, so
    // nothing reverts anywhere.
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

    // No revert. No error. The cargo simply sits at the wrong address.
    assert.equal(
      await balanceOf(viem, testToken, typo.account.address),
      ONE_TOKEN,
    );

    // The inbox never heard about it.
    assert.equal(await inbox.read.deliveryCount(), 0n);
    assert.equal(await inbox.read.totalReceived([testToken]), 0n);

    // And yet the source desk has booked it as shipped. This gap between
    // totalShipped and totalReceived is precisely what reconciliation
    // (Checkpoint 6) exists to detect.
    assert.equal(await outbox.read.totalShipped([testToken]), ONE_TOKEN);
    assert.equal(await outbox.read.shippedCount(), 1n);
  });
});

describe("Getting cargo back out", function () {
  it("lets the owner move received cargo and refuses everyone else", async function () {
    const { viem, outbox, inbox, testToken } = await deployWarehouses();
    const [, stranger] = await viem.getWalletClients();
    await dripTokens(viem, testToken, outbox.address, 1);

    await outbox.write.shipCargo([
      SEPOLIA_SELECTOR,
      inbox.address,
      testToken,
      ONE_TOKEN,
      "Pallet 42, one crate",
    ]);

    await viem.assertions.revertWithCustomError(
      inbox.write.withdrawCargo(
        [testToken, stranger.account.address, ONE_TOKEN],
        { account: stranger.account },
      ),
      inbox,
      "OwnableUnauthorizedAccount",
    );
    assert.equal(await balanceOf(viem, testToken, inbox.address), ONE_TOKEN);

    await inbox.write.withdrawCargo([
      testToken,
      stranger.account.address,
      ONE_TOKEN,
    ]);

    assert.equal(await balanceOf(viem, testToken, inbox.address), 0n);
    assert.equal(
      await balanceOf(viem, testToken, stranger.account.address),
      ONE_TOKEN,
    );

    // The books still say a token was received. Balance and ledger have
    // deliberately diverged, and only a withdrawal explains the gap.
    assert.equal(await inbox.read.totalReceived([testToken]), ONE_TOKEN);
  });
});

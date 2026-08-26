import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseEther,
  toHex,
  zeroHash,
} from "viem";
import {
  deployWarehouses,
  erc20Abi,
  mockRouterAbi,
  SEPOLIA_SELECTOR,
} from "../test-support/warehouses.js";

describe("CCIP delivery, source warehouse to destination warehouse", function () {
  it("delivers the message through the router", async function () {
    const { outbox, inbox } = await deployWarehouses();

    await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);

    assert.equal(await inbox.read.lastMessage(), "Pallet 42 released");
    assert.equal(await inbox.read.deliveryCount(), 1n);
    assert.equal(await outbox.read.shippedCount(), 1n);
    assert.notEqual(await inbox.read.lastMessageId(), zeroHash);
  });

  it("records the source warehouse and source chain, not the human who paid", async function () {
    const { outbox, inbox, operator } = await deployWarehouses();

    await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);

    // CCIP reports the contract that called ccipSend, not the wallet behind it.
    assert.equal(
      getAddress(await inbox.read.lastSourceWarehouse()),
      getAddress(outbox.address),
    );
    assert.notEqual(
      getAddress(await inbox.read.lastSourceWarehouse()),
      getAddress(operator.account.address),
    );
    assert.equal(await inbox.read.lastSourceChainSelector(), SEPOLIA_SELECTOR);
  });

  it("gives the sender the same tracking number the inbox records", async function () {
    const { viem, outbox, inbox } = await deployWarehouses();

    const hash = await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);
    const publicClient = await viem.getPublicClient();
    await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(
      await outbox.read.shippedMessageIds([0n]),
      await inbox.read.lastMessageId(),
    );
  });
});

describe("Router authentication", function () {
  it("rejects a delivery that did not come through the router", async function () {
    const { viem, inbox } = await deployWarehouses();
    const [, attacker] = await viem.getWalletClients();

    const forged = {
      messageId: keccak256(toHex("forged")),
      sourceChainSelector: SEPOLIA_SELECTOR,
      sender: encodeAbiParameters(parseAbiParameters("address"), [
        attacker.account.address,
      ]),
      data: encodeAbiParameters(parseAbiParameters("string"), [
        "Release 1,000 tokens to the attacker",
      ]),
      destTokenAmounts: [],
    } as const;

    await viem.assertions.revertWithCustomError(
      inbox.write.ccipReceive([forged], { account: attacker.account }),
      inbox,
      "InvalidRouter",
    );

    assert.equal(await inbox.read.deliveryCount(), 0n);
  });

  it("shows why Checkpoint 1's inbox was unsafe: anyone can forge a delivery", async function () {
    const { viem } = await network.create();
    const naiveInbox = await viem.deployContract("WarehouseInbox");
    const [, attacker] = await viem.getWalletClients();

    await naiveInbox.write.receiveDelivery(
      ["Release 1,000 tokens to the attacker"],
      { account: attacker.account },
    );

    assert.equal(await naiveInbox.read.deliveryCount(), 1n);
  });
});

describe("CCIP fees", function () {
  it("refuses to ship when the desk cannot pay the fee", async function () {
    const { viem, outbox, inbox, operator, sourceRouter } =
      await deployWarehouses();
    const publicClient = await viem.getPublicClient();

    const hash = await operator.writeContract({
      address: sourceRouter,
      abi: mockRouterAbi,
      functionName: "setFee",
      args: [parseEther("1")],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    assert.equal(
      await outbox.read.quoteDelivery([
        SEPOLIA_SELECTOR,
        inbox.address,
        "Pallet 42 released",
      ]),
      parseEther("1"),
    );

    await viem.assertions.revertWithCustomError(
      outbox.write.shipDelivery([
        SEPOLIA_SELECTOR,
        inbox.address,
        "Pallet 42 released",
      ]),
      outbox,
      "NotEnoughFeeTokenBalance",
    );

    assert.equal(await inbox.read.deliveryCount(), 0n);
  });

  it("pays the fee in LINK once the desk is funded", async function () {
    const { viem, ccip, outbox, inbox, operator, sourceRouter, linkToken } =
      await deployWarehouses();
    const publicClient = await viem.getPublicClient();

    let hash = await operator.writeContract({
      address: sourceRouter,
      abi: mockRouterAbi,
      functionName: "setFee",
      args: [parseEther("1")],
    });
    await publicClient.waitForTransactionReceipt({ hash });

    hash = await ccip.write.requestLinkFromFaucet([
      outbox.address,
      parseEther("5"),
    ]);
    await publicClient.waitForTransactionReceipt({ hash });

    await outbox.write.shipDelivery([
      SEPOLIA_SELECTOR,
      inbox.address,
      "Pallet 42 released",
    ]);

    const remaining = await publicClient.readContract({
      address: linkToken,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [outbox.address],
    });

    assert.equal(remaining, parseEther("4"));
    assert.equal(await inbox.read.deliveryCount(), 1n);
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

describe("WarehouseInbox", function () {
  it("starts with no deliveries", async function () {
    const { viem } = await network.create();
    const inbox = await viem.deployContract("WarehouseInbox");

    assert.equal(await inbox.read.lastMessage(), "");
    assert.equal(await inbox.read.deliveryCount(), 0n);
  });

  it("stores a delivery and records who sent it", async function () {
    const { viem } = await network.create();
    const inbox = await viem.deployContract("WarehouseInbox");
    const [courier] = await viem.getWalletClients();

    await inbox.write.receiveDelivery(["Hello from the source warehouse"]);

    assert.equal(
      await inbox.read.lastMessage(),
      "Hello from the source warehouse",
    );
    assert.equal(
      String(await inbox.read.lastCourier()).toLowerCase(),
      courier.account.address.toLowerCase(),
    );
    assert.equal(await inbox.read.deliveryCount(), 1n);
  });

  it("counts multiple deliveries", async function () {
    const { viem } = await network.create();
    const inbox = await viem.deployContract("WarehouseInbox");

    await inbox.write.receiveDelivery(["First package"]);
    await inbox.write.receiveDelivery(["Second package"]);

    assert.equal(await inbox.read.lastMessage(), "Second package");
    assert.equal(await inbox.read.deliveryCount(), 2n);
  });
});

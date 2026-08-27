import { mkdirSync, writeFileSync } from "node:fs";
import { parseEther } from "viem";
import { network } from "hardhat";

/**
 * Deploy a complete Gatehouse to a running local node and write the addresses
 * the operator CLI reads.
 *
 *   npm run node          # in one terminal
 *   npm run deploy:local  # in another
 *   npm run gatehouse -- status
 */

const ONE_HOUR = 3600n;
const ONE_TOKEN = parseEther("1");
const SEPOLIA_SELECTOR = 16015286601757825753n;

const { viem } = await network.getOrCreate("localhost");
const [operator, guardian] = await viem.getWalletClients();
const publicClient = await viem.getPublicClient();

console.log(`deploying as ${operator.account.address}`);

const ccip = await viem.deployContract("LocalCcipNetwork");
const [, sourceRouter, destinationRouter, , linkToken, testToken] =
  await ccip.read.configuration();

const outbox = await viem.deployContract("WarehouseOutbox", [
  sourceRouter,
  linkToken,
]);
const inbox = await viem.deployContract("CcipWarehouseInbox", [
  destinationRouter,
]);

// Trust, in both directions.
await outbox.write.setShipper([operator.account.address, true]);
await outbox.write.setDestination([SEPOLIA_SELECTOR, inbox.address, true]);
await outbox.write.setToken([testToken, true]);
await inbox.write.setSourceWarehouse([SEPOLIA_SELECTOR, outbox.address, true]);

// Controls: a guardian on both desks, a delivery-rate cap, and a hold on
// anything at or above two tokens.
await outbox.write.setGuardian([guardian.account.address]);
await inbox.write.setGuardian([guardian.account.address]);
await outbox.write.setLimit(["0x0000000000000000000000000000000000000000", true, 10n, ONE_HOUR]);
await inbox.write.setLimit(["0x0000000000000000000000000000000000000000", true, 10n, ONE_HOUR]);
await inbox.write.setLargeTransferThreshold([testToken, ONE_TOKEN * 2n]);
const hash = await inbox.write.setReleaseDelay([ONE_HOUR]);
await publicClient.waitForTransactionReceipt({ hash });

const deployment = {
  network: "localhost",
  chainSelector: SEPOLIA_SELECTOR.toString(),
  outbox: outbox.address,
  inbox: inbox.address,
  ccip: ccip.address,
  router: sourceRouter,
  linkToken,
  tokens: [testToken],
  guardian: guardian.account.address,
};

mkdirSync("deployments", { recursive: true });
writeFileSync(
  "deployments/local.json",
  `${JSON.stringify(deployment, null, 2)}\n`,
);

console.log(JSON.stringify(deployment, null, 2));
console.log("\nwrote deployments/local.json");

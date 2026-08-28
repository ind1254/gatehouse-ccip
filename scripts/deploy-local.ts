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
const MESSAGE_COUNT_BUCKET = "0x0000000000000000000000000000000000000000" as const;

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

// Roles: move the emergency stop onto a second wallet and take it away from
// the deployer, so the local deployment actually demonstrates the split rather
// than describing it. CONFIG and TREASURY stay with the deployer for
// convenience; a testnet deployment separates all three.
const GUARDIAN_ROLE = await outbox.read.GUARDIAN_ROLE();
await outbox.write.setRole([GUARDIAN_ROLE, guardian.account.address, true]);
await outbox.write.setRole([GUARDIAN_ROLE, operator.account.address, false]);
await inbox.write.setRole([GUARDIAN_ROLE, guardian.account.address, true]);
await inbox.write.setRole([GUARDIAN_ROLE, operator.account.address, false]);

// Limits: ten deliveries an hour on this lane, refilling continuously rather
// than resetting, so there is no window boundary to burst across.
const deliveryBudget = {
  enabled: true,
  capacity: 10n,
  refillAmount: 10n,
  refillPeriod: ONE_HOUR,
} as const;

await outbox.write.setLimit([SEPOLIA_SELECTOR, MESSAGE_COUNT_BUCKET, deliveryBudget]);
await inbox.write.setLimit([SEPOLIA_SELECTOR, MESSAGE_COUNT_BUCKET, deliveryBudget]);

// A hold on anything at or above two tokens.
await inbox.write.setLargeTransferThreshold([testToken, ONE_TOKEN * 2n]);
const hash = await inbox.write.setReleaseDelay([ONE_HOUR]);
await publicClient.waitForTransactionReceipt({ hash });

const deployment = {
  network: "localhost",
  outbox: outbox.address,
  inbox: inbox.address,
  ccip: ccip.address,
  router: sourceRouter,
  linkToken,
  tokens: [{ symbol: "CCIP-BnM", source: testToken, destination: testToken }],
  // One local chain plays both ends, so both selectors are the same one.
  sourceChainSelector: SEPOLIA_SELECTOR.toString(),
  destinationChainSelector: SEPOLIA_SELECTOR.toString(),
  // One local chain, so delivery is instant. A testnet lane sets this from
  // the source chain finality time.
  expectedLatencySeconds: 5,
  guardian: guardian.account.address,
};

mkdirSync("deployments", { recursive: true });
writeFileSync(
  "deployments/local.json",
  `${JSON.stringify(deployment, null, 2)}\n`,
);

console.log(JSON.stringify(deployment, null, 2));
console.log("\nwrote deployments/local.json");

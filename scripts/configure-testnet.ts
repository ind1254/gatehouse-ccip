import { readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA } from "../src/networks.js";

/**
 * Introduce the two desks to each other, once both are deployed.
 *
 *   npx hardhat run scripts/configure-testnet.ts --network sepolia
 *   npx hardhat run scripts/configure-testnet.ts --network baseSepolia
 *
 * Run it on BOTH networks: each side holds its own allowlist, and neither can
 * write to the other's storage. Two chains means two transactions.
 *
 * Note the ordering here. Limits and the destination gas budget are configured
 * BEFORE the allowlist entry that makes shipping possible, so the desks are
 * never briefly live with no caps on them.
 */

const DEPLOYMENT_FILE = "deployments/testnet.json";
const ONE_HOUR = 3600n;
const ONE_TOKEN = 10n ** 18n;

const deployment = JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8"));
if (!deployment.source || !deployment.destination) {
  throw new Error(
    "Both sides must be deployed first. Run scripts/deploy-testnet.ts on " +
      "sepolia and on baseSepolia.",
  );
}

const { viem } = await network.connect();
const publicClient = await viem.getPublicClient();
const [operator] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

const sourceSelector = BigInt(deployment.source.chainSelector);
const destinationSelector = BigInt(deployment.destination.chainSelector);

if (chainId === ETHEREUM_SEPOLIA.chainId) {
  console.log("configuring the shipping desk on Ethereum Sepolia");
  const outbox = await viem.getContractAt(
    "WarehouseOutbox",
    deployment.source.outbox,
  );

  // Caps first, so the desk is never live without them.
  await outbox.write.setLimit([
    "0x0000000000000000000000000000000000000000",
    true,
    5n,
    ONE_HOUR,
  ]);
  console.log("  delivery limit   5 per hour");

  if (deployment.source.testToken) {
    await outbox.write.setLimit([
      deployment.source.testToken,
      true,
      ONE_TOKEN * 5n,
      ONE_HOUR,
    ]);
    await outbox.write.setToken([deployment.source.testToken, true]);
    console.log(`  cargo limit      5 tokens per hour`);
    console.log(`  allowed token    ${deployment.source.testToken}`);
  } else {
    console.log("  NOTE: no testToken configured for this chain; cargo disabled");
  }

  // Then the permissions that let anything move at all.
  await outbox.write.setShipper([operator.account.address, true]);
  await outbox.write.setDestination([
    destinationSelector,
    deployment.destination.inbox,
    true,
  ]);
  const hash = await outbox.write.setGuardian([operator.account.address]);
  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`  shipper          ${operator.account.address}`);
  console.log(`  destination      ${deployment.destination.inbox} on Base Sepolia`);
  console.log(
    "\n  GUARDIAN IS THE DEPLOYER. On a real system these are different keys:\n" +
      "  the guardian is a hot key that can only pause, and the owner is cold.",
  );
} else if (chainId === BASE_SEPOLIA.chainId) {
  console.log("configuring the receiving desk on Base Sepolia");
  const inbox = await viem.getContractAt(
    "CcipWarehouseInbox",
    deployment.destination.inbox,
  );

  await inbox.write.setLimit([
    "0x0000000000000000000000000000000000000000",
    true,
    5n,
    ONE_HOUR,
  ]);
  console.log("  delivery limit   5 per hour");

  if (deployment.destination.testToken) {
    await inbox.write.setLimit([
      deployment.destination.testToken,
      true,
      ONE_TOKEN * 5n,
      ONE_HOUR,
    ]);
    await inbox.write.setLargeTransferThreshold([
      deployment.destination.testToken,
      ONE_TOKEN * 2n,
    ]);
    console.log("  cargo limit      5 tokens per hour");
    console.log("  hold threshold   2 tokens");
  } else {
    console.log(
      "  NOTE: no testToken configured for Base Sepolia. Look up CCIP-BnM in\n" +
        "  the CCIP directory and set it in src/networks.ts before shipping cargo.",
    );
  }

  await inbox.write.setReleaseDelay([ONE_HOUR]);
  await inbox.write.setSourceWarehouse([
    sourceSelector,
    deployment.source.outbox,
    true,
  ]);
  const hash = await inbox.write.setGuardian([operator.account.address]);
  await publicClient.waitForTransactionReceipt({ hash });

  console.log("  release delay    3600s");
  console.log(
    `  trusted source   ${deployment.source.outbox} on Ethereum Sepolia`,
  );
} else {
  throw new Error(`Chain ${chainId} is not part of this deployment.`);
}

deployment.configured = true;
writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`\nupdated ${DEPLOYMENT_FILE}`);

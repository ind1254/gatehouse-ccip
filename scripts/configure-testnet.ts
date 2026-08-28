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
const MESSAGE_COUNT_BUCKET = "0x0000000000000000000000000000000000000000" as const;

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

/**
 * The deployer holds GUARDIAN, CONFIG and TREASURY on a fresh deployment.
 * Splitting them - and setting a non-zero trustDelay so widening changes have
 * to be announced - is the last step, and it is deliberately left to a human
 * with the keys rather than automated here.
 */
function printRoleWarning() {
  console.log(
    [
      "",
      "  ALL THREE ROLES ARE STILL THE DEPLOYER, AND trustDelay IS 0.",
      "  Before this holds anything worth taking:",
      "    setRole(GUARDIAN_ROLE, <hot key>, true)",
      "    setRole(TREASURY_ROLE, <cold key>, true)",
      "    setRole(<each role>, <deployer>, false)",
      "    setTrustDelay(<seconds>)   // raising it applies immediately",
      "",
      "  Grant roles BEFORE raising the delay: granting is itself a widening",
      "  change, so afterwards it would need scheduling too.",
    ].join("\n"),
  );
}

const sourceSelector = BigInt(deployment.source.chainSelector);
const destinationSelector = BigInt(deployment.destination.chainSelector);

if (chainId === ETHEREUM_SEPOLIA.chainId) {
  console.log("configuring the shipping desk on Ethereum Sepolia");
  const outbox = await viem.getContractAt(
    "WarehouseOutbox",
    deployment.source.outbox,
  );

  // Caps first, so the desk is never live without them. A token bucket, so
  // there is no window boundary to burst across.
  await outbox.write.setLimit([
    destinationSelector,
    MESSAGE_COUNT_BUCKET,
    { enabled: true, capacity: 5n, refillAmount: 5n, refillPeriod: ONE_HOUR },
  ]);
  console.log("  delivery limit   burst 5, refills 5 per hour");

  if (deployment.source.testToken) {
    await outbox.write.setLimit([
      destinationSelector,
      deployment.source.testToken,
      {
        enabled: true,
        capacity: ONE_TOKEN * 5n,
        refillAmount: ONE_TOKEN * 5n,
        refillPeriod: ONE_HOUR,
      },
    ]);
    await outbox.write.setToken([deployment.source.testToken, true]);
    console.log(`  cargo limit      burst 5 tokens, refills 5 per hour`);
    console.log(`  allowed token    ${deployment.source.testToken}`);
  } else {
    console.log("  NOTE: no testToken configured for this chain; cargo disabled");
  }

  // Then the permissions that let anything move at all.
  await outbox.write.setShipper([operator.account.address, true]);
  const hash = await outbox.write.setDestination([
    destinationSelector,
    deployment.destination.inbox,
    true,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  console.log(`  shipper          ${operator.account.address}`);
  console.log(`  destination      ${deployment.destination.inbox} on Base Sepolia`);
  printRoleWarning();
} else if (chainId === BASE_SEPOLIA.chainId) {
  console.log("configuring the receiving desk on Base Sepolia");
  const inbox = await viem.getContractAt(
    "CcipWarehouseInbox",
    deployment.destination.inbox,
  );

  await inbox.write.setLimit([
    sourceSelector,
    MESSAGE_COUNT_BUCKET,
    { enabled: true, capacity: 5n, refillAmount: 5n, refillPeriod: ONE_HOUR },
  ]);
  console.log("  delivery limit   burst 5, refills 5 per hour");

  if (deployment.destination.testToken) {
    await inbox.write.setLimit([
      sourceSelector,
      deployment.destination.testToken,
      {
        enabled: true,
        capacity: ONE_TOKEN * 5n,
        refillAmount: ONE_TOKEN * 5n,
        refillPeriod: ONE_HOUR,
      },
    ]);
    await inbox.write.setLargeTransferThreshold([
      deployment.destination.testToken,
      ONE_TOKEN * 2n,
    ]);
    console.log("  cargo limit      burst 5 tokens, refills 5 per hour");
    console.log("  hold threshold   2 tokens");
  } else {
    console.log(
      "  NOTE: no testToken configured for Base Sepolia. Look up CCIP-BnM in\n" +
        "  the CCIP directory and set it in src/networks.ts before shipping cargo.",
    );
  }

  await inbox.write.setReleaseDelay([ONE_HOUR]);
  const hash = await inbox.write.setSourceWarehouse([
    sourceSelector,
    deployment.source.outbox,
    true,
  ]);
  await publicClient.waitForTransactionReceipt({ hash });

  console.log("  release delay    3600s");
  console.log(
    `  trusted source   ${deployment.source.outbox} on Ethereum Sepolia`,
  );
  printRoleWarning();
} else {
  throw new Error(`Chain ${chainId} is not part of this deployment.`);
}

deployment.configured = true;
writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
console.log(`\nupdated ${DEPLOYMENT_FILE}`);

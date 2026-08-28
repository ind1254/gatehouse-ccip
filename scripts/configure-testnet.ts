import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA } from "../src/networks.js";
import { converge, formatPlan, type ConfigStep } from "../src/converge.js";

/**
 * Bring each desk to its desired configuration, idempotently.
 *
 *   npx hardhat run scripts/configure-testnet.ts --network sepolia
 *   npx hardhat run scripts/configure-testnet.ts --network baseSepolia
 *
 * Run it on BOTH networks: each side holds its own allowlist, and neither chain
 * can write to the other's storage.
 *
 * This describes the state it wants, reads what the chain actually says, and
 * sends only the difference. Running it twice sends nothing the second time,
 * and running it after a partial failure resumes rather than repeating.
 *
 * Ordering still matters and is preserved: limits and thresholds come before the
 * allowlist entries that make shipping possible, so a run that stops half way
 * cannot leave a desk live with no caps on it.
 *
 * Pass --dry-run to print the plan without sending anything.
 */

const DEPLOYMENT_FILE = "deployments/testnet.json";
const ONE_HOUR = 3600n;
const ONE_TOKEN = 10n ** 18n;
const MESSAGE_COUNT_BUCKET = "0x0000000000000000000000000000000000000000" as const;

const dryRun = process.argv.includes("--dry-run");

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

/** A limit rendered as one comparable value, so a diff is a string compare. */
function describeLimit(limit: readonly [boolean, bigint, bigint, bigint]): string {
  const [enabled, capacity, refillAmount, refillPeriod] = limit;
  return enabled
    ? `capacity ${capacity}, refills ${refillAmount} per ${refillPeriod}s`
    : "unlimited";
}

const budget = (capacity: bigint, refillAmount: bigint) =>
  ({ enabled: true, capacity, refillAmount, refillPeriod: ONE_HOUR }) as const;

const wantedDeliveryBudget = describeLimit([true, 5n, 5n, ONE_HOUR]);
const wantedCargoBudget = describeLimit([
  true,
  ONE_TOKEN * 5n,
  ONE_TOKEN * 5n,
  ONE_HOUR,
]);

let steps: ConfigStep[] = [];

if (chainId === ETHEREUM_SEPOLIA.chainId) {
  console.log("configuring the shipping desk on Ethereum Sepolia\n");
  const outbox = await viem.getContractAt(
    "WarehouseOutbox",
    deployment.source.outbox,
  );
  const token = deployment.source.testToken;

  steps = [
    {
      description: "delivery budget on the Base Sepolia lane",
      desired: wantedDeliveryBudget,
      read: async () =>
        describeLimit(
          await outbox.read.limit([destinationSelector, MESSAGE_COUNT_BUCKET]),
        ),
      apply: () =>
        outbox.write.setLimit([
          destinationSelector,
          MESSAGE_COUNT_BUCKET,
          budget(5n, 5n),
        ]),
    },
  ];

  if (token) {
    steps.push(
      {
        description: "cargo budget on the Base Sepolia lane",
        desired: wantedCargoBudget,
        read: async () =>
          describeLimit(await outbox.read.limit([destinationSelector, token])),
        apply: () =>
          outbox.write.setLimit([
            destinationSelector,
            token,
            budget(ONE_TOKEN * 5n, ONE_TOKEN * 5n),
          ]),
      },
      {
        description: `token ${token} allowed as cargo`,
        desired: true,
        read: () => outbox.read.allowedToken([token]),
        apply: () => outbox.write.setToken([token, true]),
      },
    );
  } else {
    console.log(
      "NOTE: no testToken configured for this chain, so cargo stays disabled.\n",
    );
  }

  steps.push(
    {
      description: `shipper ${operator.account.address}`,
      desired: true,
      read: () => outbox.read.isShipper([operator.account.address]),
      apply: () => outbox.write.setShipper([operator.account.address, true]),
    },
    {
      description: `destination ${deployment.destination.inbox} on Base Sepolia`,
      desired: true,
      read: () =>
        outbox.read.allowedDestination([
          destinationSelector,
          deployment.destination.inbox,
        ]),
      apply: () =>
        outbox.write.setDestination([
          destinationSelector,
          deployment.destination.inbox,
          true,
        ]),
    },
  );
} else if (chainId === BASE_SEPOLIA.chainId) {
  console.log("configuring the receiving desk on Base Sepolia\n");
  const inbox = await viem.getContractAt(
    "CcipWarehouseInbox",
    deployment.destination.inbox,
  );
  const token = deployment.destination.testToken;

  steps = [
    {
      description: "delivery budget on the Ethereum Sepolia lane",
      desired: wantedDeliveryBudget,
      read: async () =>
        describeLimit(
          await inbox.read.limit([sourceSelector, MESSAGE_COUNT_BUCKET]),
        ),
      apply: () =>
        inbox.write.setLimit([
          sourceSelector,
          MESSAGE_COUNT_BUCKET,
          budget(5n, 5n),
        ]),
    },
  ];

  if (token) {
    steps.push(
      {
        description: "cargo budget on the Ethereum Sepolia lane",
        desired: wantedCargoBudget,
        read: async () =>
          describeLimit(await inbox.read.limit([sourceSelector, token])),
        apply: () =>
          inbox.write.setLimit([
            sourceSelector,
            token,
            budget(ONE_TOKEN * 5n, ONE_TOKEN * 5n),
          ]),
      },
      {
        description: "hold threshold of 2 tokens",
        desired: ONE_TOKEN * 2n,
        read: () => inbox.read.largeTransferThreshold([token]),
        apply: () =>
          inbox.write.setLargeTransferThreshold([token, ONE_TOKEN * 2n]),
      },
    );
  } else {
    console.log(
      "NOTE: no testToken configured for Base Sepolia. Look up CCIP-BnM in the\n" +
        "CCIP directory and set it in src/networks.ts before shipping cargo.\n",
    );
  }

  steps.push(
    {
      description: "release delay of one hour",
      desired: ONE_HOUR,
      read: () => inbox.read.releaseDelay(),
      apply: () => inbox.write.setReleaseDelay([ONE_HOUR]),
    },
    {
      description: `trusted source ${deployment.source.outbox} on Ethereum Sepolia`,
      desired: true,
      read: () =>
        inbox.read.allowedSourceWarehouse([
          sourceSelector,
          deployment.source.outbox,
        ]),
      apply: () =>
        inbox.write.setSourceWarehouse([
          sourceSelector,
          deployment.source.outbox,
          true,
        ]),
    },
  );
} else {
  throw new Error(`Chain ${chainId} is not part of this deployment.`);
}

const result = await converge(steps, { dryRun });
console.log(formatPlan(result.plan));

if (dryRun) {
  console.log("\n--dry-run: nothing was sent.");
} else if (result.applied.length > 0) {
  console.log(`\nsent ${result.applied.length} transaction(s):`);
  for (const step of result.applied) console.log(`  ${step}`);
} else {
  console.log("\nNothing to do. Run it again and it will say the same.");
}

printRoleWarning();

if (!dryRun && result.plan.converged) {
  deployment.configured = true;
  const temporary = `${DEPLOYMENT_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(deployment, null, 2)}\n`);
  renameSync(temporary, DEPLOYMENT_FILE);
  console.log(`\nupdated ${DEPLOYMENT_FILE}`);
}

/**
 * The deployer holds GUARDIAN, CONFIG and TREASURY on a fresh deployment.
 * Splitting them - and setting a non-zero trustDelay so widening changes must be
 * announced - is deliberately left to a human with the keys rather than
 * automated here.
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

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Address, PublicClient } from "viem";
import { network } from "hardhat";
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA, type CcipNetwork } from "../src/networks.js";
import {
  decideDeployment,
  predictDeployment,
  verifyAdopted,
  type PendingDeployment,
} from "../src/adopt.js";

/**
 * Deploy one side of the bridge, idempotently.
 *
 *   npx hardhat run scripts/deploy-testnet.ts --network sepolia      # outbox
 *   npx hardhat run scripts/deploy-testnet.ts --network baseSepolia  # inbox
 *
 * Safe to run repeatedly. The chain is the record of what exists; this file is
 * a cache of it. Before deploying anything the script asks the chain whether
 * the work is already done, including in the window where a previous run's
 * transaction landed but the run died before writing the address down.
 */

const DEPLOYMENT_FILE = "deployments/testnet.json";

interface SideRecord {
  network: string;
  chainId: number;
  chainSelector: string;
  outbox?: Address;
  inbox?: Address;
  router: Address;
  linkToken: Address;
  testToken?: Address;
  deployedAtBlock: string;
  explorer: string;
}

interface TestnetDeployment {
  source?: SideRecord;
  destination?: SideRecord;
  /** Written before a deployment is sent, cleared once it is recorded. */
  pending?: Record<string, PendingDeployment>;
  configured?: boolean;
}

function readDeployment(): TestnetDeployment {
  if (!existsSync(DEPLOYMENT_FILE)) return {};
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as TestnetDeployment;
}

/** Temp-then-rename, so an interrupted write cannot leave a torn file. */
function writeDeployment(deployment: TestnetDeployment): void {
  mkdirSync("deployments", { recursive: true });
  const temporary = `${DEPLOYMENT_FILE}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(deployment, null, 2)}\n`);
  renameSync(temporary, DEPLOYMENT_FILE);
}

const { viem } = await network.connect();
const publicClient = (await viem.getPublicClient()) as unknown as PublicClient;
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

const SIDES: Record<number, { side: "source" | "destination"; config: CcipNetwork }> = {
  [ETHEREUM_SEPOLIA.chainId]: { side: "source", config: ETHEREUM_SEPOLIA },
  [BASE_SEPOLIA.chainId]: { side: "destination", config: BASE_SEPOLIA },
};

const target = SIDES[chainId];
if (!target) {
  throw new Error(
    `Chain ${chainId} is not one of the ` +
      `two lanes this project deploys to. Expected Ethereum Sepolia ` +
      `(${ETHEREUM_SEPOLIA.chainId}) or Base Sepolia (${BASE_SEPOLIA.chainId}).`,
  );
}

const { side, config } = target;
const deployerAddress = deployer.account.address as Address;
const balance = await publicClient.getBalance({ address: deployerAddress });

console.log(`network   ${config.name} (chain ${chainId})`);
console.log(`deployer  ${deployerAddress}`);
console.log(`balance   ${balance} wei`);
console.log(`router    ${config.router}`);

const deployment = readDeployment();
const existingSide = deployment[side];
const recordedAddress =
  side === "source" ? existingSide?.outbox : existingSide?.inbox;

const decision = await decideDeployment(publicClient, deployerAddress, {
  address: recordedAddress,
  pending: deployment.pending?.[side],
});

console.log(`\ndecision  ${decision.action} - ${decision.reason}`);

let address: Address;

if (decision.action === "adopt") {
  address = decision.address;

  // Code at an address proves something is there, not that it is ours. Read a
  // value only our contract exposes before trusting it.
  const contract = await viem.getContractAt(
    side === "source" ? "WarehouseOutbox" : "CcipWarehouseInbox",
    address,
  );
  const check = await verifyAdopted(
    async () =>
      side === "source"
        ? ((await (contract as { read: { router: () => Promise<string> } }).read.router()) as string)
        : ((await (contract as { read: { getRouter: () => Promise<string> } }).read.getRouter()) as string),
    config.router,
    "configured CCIP router",
  );

  if (!check.ok) {
    throw new Error(
      `Refusing to adopt ${address}: ${check.detail}.\n` +
        "Something else is deployed there. Remove the stale record from " +
        `${DEPLOYMENT_FILE} once you know what it is.`,
    );
  }
  console.log(`verified  ${check.detail}`);
} else {
  if (balance === 0n) {
    throw new Error(
      "The deployer has no native balance. Fund it from a faucet before " +
        "deploying; see docs/DEPLOYMENT.md.",
    );
  }

  // Write the intent BEFORE sending. If this process dies between the send and
  // the record, the next run can find the contract from the predicted address.
  const pending = await predictDeployment(publicClient, deployerAddress);
  deployment.pending = { ...deployment.pending, [side]: pending };
  writeDeployment(deployment);
  console.log(`predicted ${pending.predictedAddress} (nonce ${pending.nonce})`);

  const deployed =
    side === "source"
      ? await viem.deployContract("WarehouseOutbox", [config.router, config.linkToken])
      : await viem.deployContract("CcipWarehouseInbox", [config.router]);

  address = deployed.address as Address;

  if (address.toLowerCase() !== pending.predictedAddress.toLowerCase()) {
    // Not fatal, but worth knowing: something else sent a transaction from this
    // account in between, so crash recovery would have looked in the wrong place.
    console.log(
      `NOTE: landed at ${address}, not the predicted ${pending.predictedAddress}. ` +
        "The deployer's nonce moved underneath this run.",
    );
  }
  console.log(`deployed  ${address}`);
}

console.log(`${config.explorer}/address/${address}`);

const block = await publicClient.getBlockNumber();
const record: SideRecord = {
  network: config.name,
  chainId: config.chainId,
  chainSelector: config.chainSelector.toString(),
  router: config.router,
  linkToken: config.linkToken,
  testToken: config.testToken,
  // Keep the original deployment block when adopting: it is where the indexer
  // starts scanning, and moving it forward would hide earlier history.
  deployedAtBlock: existingSide?.deployedAtBlock ?? block.toString(),
  explorer: config.explorer,
  ...(side === "source" ? { outbox: address } : { inbox: address }),
};

deployment[side] = record;
if (deployment.pending) delete deployment.pending[side];
writeDeployment(deployment);

console.log(`\nwrote ${DEPLOYMENT_FILE}`);
if (!deployment.source || !deployment.destination) {
  console.log("Deploy the other side next, then run scripts/configure-testnet.ts.");
} else {
  console.log("Both sides deployed. Run scripts/configure-testnet.ts on each network.");
}

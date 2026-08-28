import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { network } from "hardhat";
import { BASE_SEPOLIA, ETHEREUM_SEPOLIA, type CcipNetwork } from "../src/networks.js";

/**
 * Deploy one side of the bridge to a testnet, and merge the result into
 * deployments/testnet.json.
 *
 *   npx hardhat run scripts/deploy-testnet.ts --network sepolia      # outbox
 *   npx hardhat run scripts/deploy-testnet.ts --network baseSepolia  # inbox
 *
 * Run both, then scripts/configure-testnet.ts to introduce them to each other.
 * The two sides cannot be configured at deploy time because neither knows the
 * other's address until both exist.
 *
 * Router and LINK addresses come from src/networks.ts, which records the CCIP
 * directory page they were copied from.
 */

const DEPLOYMENT_FILE = "deployments/testnet.json";

interface TestnetDeployment {
  source?: {
    network: string;
    chainId: number;
    chainSelector: string;
    outbox: string;
    router: string;
    linkToken: string;
    testToken?: string;
    deployedAtBlock: string;
    explorer: string;
  };
  destination?: {
    network: string;
    chainId: number;
    chainSelector: string;
    inbox: string;
    router: string;
    linkToken: string;
    testToken?: string;
    deployedAtBlock: string;
    explorer: string;
  };
  configured?: boolean;
}

function readDeployment(): TestnetDeployment {
  if (!existsSync(DEPLOYMENT_FILE)) return {};
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, "utf8")) as TestnetDeployment;
}

function writeDeployment(deployment: TestnetDeployment): void {
  mkdirSync("deployments", { recursive: true });
  writeFileSync(DEPLOYMENT_FILE, `${JSON.stringify(deployment, null, 2)}\n`);
}

const { viem, networkName } = await network.connect();
const publicClient = await viem.getPublicClient();
const [deployer] = await viem.getWalletClients();
const chainId = await publicClient.getChainId();

const SIDES: Record<number, { side: "source" | "destination"; config: CcipNetwork }> = {
  [ETHEREUM_SEPOLIA.chainId]: { side: "source", config: ETHEREUM_SEPOLIA },
  [BASE_SEPOLIA.chainId]: { side: "destination", config: BASE_SEPOLIA },
};

const target = SIDES[chainId];
if (!target) {
  throw new Error(
    `Chain ${chainId} (network '${networkName}') is not one of the two lanes ` +
      `this project deploys to. Expected Ethereum Sepolia (${ETHEREUM_SEPOLIA.chainId}) ` +
      `or Base Sepolia (${BASE_SEPOLIA.chainId}).`,
  );
}

const { side, config } = target;
const balance = await publicClient.getBalance({ address: deployer.account.address });

console.log(`network   ${config.name} (chain ${chainId})`);
console.log(`deployer  ${deployer.account.address}`);
console.log(`balance   ${balance} wei`);
console.log(`router    ${config.router}`);

if (balance === 0n) {
  throw new Error(
    "The deployer has no native balance. Fund it from a faucet before " +
      "deploying; see docs/DEPLOYMENT.md.",
  );
}

const deployment = readDeployment();

if (side === "source") {
  const outbox = await viem.deployContract("WarehouseOutbox", [
    config.router,
    config.linkToken,
  ]);
  const block = await publicClient.getBlockNumber();

  console.log(`\nWarehouseOutbox deployed at ${outbox.address}`);
  console.log(`${config.explorer}/address/${outbox.address}`);

  deployment.source = {
    network: config.name,
    chainId: config.chainId,
    chainSelector: config.chainSelector.toString(),
    outbox: outbox.address,
    router: config.router,
    linkToken: config.linkToken,
    testToken: config.testToken,
    deployedAtBlock: block.toString(),
    explorer: config.explorer,
  };
} else {
  const inbox = await viem.deployContract("CcipWarehouseInbox", [config.router]);
  const block = await publicClient.getBlockNumber();

  console.log(`\nCcipWarehouseInbox deployed at ${inbox.address}`);
  console.log(`${config.explorer}/address/${inbox.address}`);

  deployment.destination = {
    network: config.name,
    chainId: config.chainId,
    chainSelector: config.chainSelector.toString(),
    inbox: inbox.address,
    router: config.router,
    linkToken: config.linkToken,
    testToken: config.testToken,
    deployedAtBlock: block.toString(),
    explorer: config.explorer,
  };
}

deployment.configured = false;
writeDeployment(deployment);

console.log(`\nwrote ${DEPLOYMENT_FILE}`);
if (!deployment.source || !deployment.destination) {
  console.log("Deploy the other side next, then run scripts/configure-testnet.ts.");
} else {
  console.log("Both sides deployed. Run scripts/configure-testnet.ts on each network.");
}

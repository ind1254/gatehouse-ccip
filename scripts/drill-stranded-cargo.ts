import { parseAbi, parseEther } from "viem";
import { readFileSync } from "node:fs";
import { network } from "hardhat";

/**
 * Failure drill: ship cargo to an address with no contract on it.
 *
 * CCIP reports this as a SUCCESS. Nothing reverts, no error is emitted, and the
 * receiving desk never hears about it. The tokens settle at the wrong address
 * permanently. Run `npm run gatehouse -- reconcile` afterwards: the only thing
 * that notices is the ledger comparison.
 */

const SEPOLIA_SELECTOR = 16015286601757825753n;
const ONE_TOKEN = parseEther("1");

const deployment = JSON.parse(readFileSync("deployments/local.json", "utf8"));

const { viem } = await network.getOrCreate("localhost");
const [operator, , bystander] = await viem.getWalletClients();
const publicClient = await viem.getPublicClient();

const outbox = await viem.getContractAt("WarehouseOutbox", deployment.outbox);
const testToken = deployment.tokens[0].source;

// Fund the desk.
for (let i = 0; i < 2; i++) {
  const hash = await operator.writeContract({
    address: testToken,
    abi: parseAbi(["function drip(address to)"]),
    functionName: "drip",
    args: [deployment.outbox],
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

// A plain wallet address. No contract lives here.
const typo = bystander.account.address;
console.log(`shipping one token to ${typo} - an address with no contract`);

await outbox.write.setDestination([SEPOLIA_SELECTOR, typo, true]);
const hash = await outbox.write.shipCargo([
  SEPOLIA_SELECTOR,
  typo,
  testToken,
  ONE_TOKEN,
  "Pallet 42, one crate",
]);
const receipt = await publicClient.waitForTransactionReceipt({ hash });

console.log(`transaction status: ${receipt.status}`);
console.log("No revert. No error. Now run:  npm run gatehouse -- reconcile");

import assert from "node:assert/strict";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  parseEther,
  type Address,
  type Hex,
} from "viem";

/// The mock router always reports deliveries as coming from Ethereum Sepolia.
export const SEPOLIA_SELECTOR = 16015286601757825753n;

/// A chain we never allowlist, used to prove the source check bites.
export const BASE_SEPOLIA_SELECTOR = 10344971235874465080n;

export const erc20Abi = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

export const mockRouterAbi = parseAbi(["function setFee(uint256 feeAmount)"]);

/// CCIP-BnM is Chainlink's test token. `drip` mints exactly one whole token.
export const testTokenAbi = parseAbi([
  "function drip(address to)",
  "function balanceOf(address account) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);

/// One whole CCIP-BnM token, in the token's smallest unit (18 decimals).
export const ONE_TOKEN = parseEther("1");

/**
 * Stand up the whole cross-chain setup on one local blockchain: a shipping
 * desk, the CCIP network, and a receiving desk.
 *
 * By default the two desks are configured to trust each other and the first
 * wallet is an authorised shipper. Pass `configure: false` for the raw,
 * unconfigured deployment.
 */
export async function deployWarehouses({ configure = true } = {}) {
  const { viem, networkHelpers } = await network.create();

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

  const [operator] = await viem.getWalletClients();

  if (configure) {
    await outbox.write.setShipper([operator.account.address, true]);
    await outbox.write.setDestination([SEPOLIA_SELECTOR, inbox.address, true]);
    await inbox.write.setSourceWarehouse([
      SEPOLIA_SELECTOR,
      outbox.address,
      true,
    ]);
    await outbox.write.setToken([testToken, true]);
  }

  return {
    viem,
    networkHelpers,
    ccip,
    outbox,
    inbox,
    operator,
    sourceRouter,
    destinationRouter,
    linkToken,
    testToken,
  };
}

/**
 * Mint whole CCIP-BnM tokens to an address, one `drip` at a time, and wait for
 * the last one so balances are settled before the caller reads them.
 */
export async function dripTokens(
  viem: Warehouses["viem"],
  token: Address,
  to: Address,
  wholeTokens: number,
) {
  const [operator] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();

  for (let i = 0; i < wholeTokens; i++) {
    const hash = await operator.writeContract({
      address: token,
      abi: testTokenAbi,
      functionName: "drip",
      args: [to],
    });
    await publicClient.waitForTransactionReceipt({ hash });
  }
}

/** Read an ERC-20 balance. */
export async function balanceOf(
  viem: Warehouses["viem"],
  token: Address,
  account: Address,
) {
  const publicClient = await viem.getPublicClient();
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account],
  });
}

/** Read an ERC-20 total supply. */
export async function totalSupplyOf(
  viem: Warehouses["viem"],
  token: Address,
) {
  const publicClient = await viem.getPublicClient();
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "totalSupply",
  });
}

type Warehouses = Awaited<ReturnType<typeof deployWarehouses>>;

/**
 * Deliver a message straight into an inbox while pretending to be the router.
 *
 * The mock router swallows a receiver's revert reason and re-throws its own
 * `ReceiverError`, so an end-to-end test can only assert "it failed". Speaking
 * to the inbox as the router lets us assert exactly WHICH gate rejected the
 * delivery.
 */
export async function deliverAsRouter(
  networkHelpers: Warehouses["networkHelpers"],
  inbox: Warehouses["inbox"],
  router: Address,
  delivery: {
    messageId: Hex;
    sourceChainSelector: bigint;
    sender: Address;
    text: string;
  },
) {
  await networkHelpers.impersonateAccount(router);
  await networkHelpers.setBalance(router, parseEther("1"));

  const message = {
    messageId: delivery.messageId,
    sourceChainSelector: delivery.sourceChainSelector,
    sender: encodeAbiParameters(parseAbiParameters("address"), [
      delivery.sender,
    ]),
    data: encodeAbiParameters(parseAbiParameters("string"), [delivery.text]),
    destTokenAmounts: [],
  } as const;

  return inbox.write.ccipReceive([message], { account: router });
}

/**
 * Assert that an end-to-end shipment failed *because of a specific gate in the
 * inbox*.
 *
 * The router does not let the receiver's revert bubble up as-is: it catches the
 * failure and re-throws `ReceiverError(bytes)` with the original revert data
 * nested inside. So we encode the error we expect and look for its bytes in
 * the wrapper.
 */
export async function assertRevertedInsideReceiver(
  action: Promise<unknown>,
  expectedInnerError: Hex,
) {
  try {
    await action;
  } catch (error) {
    const reported = String(error).toLowerCase();
    assert.ok(
      reported.includes("receivererror"),
      `expected the router to wrap a receiver failure, got: ${error}`,
    );
    assert.ok(
      reported.includes(expectedInnerError.toLowerCase().slice(2)),
      `expected the wrapped error to be ${expectedInnerError}, got: ${error}`,
    );
    return;
  }
  assert.fail("expected the delivery to revert, but it succeeded");
}

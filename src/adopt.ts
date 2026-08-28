import { getContractAddress, type Address, type PublicClient } from "viem";

/**
 * Recovering a deployment whose transaction succeeded but whose local record
 * did not.
 *
 * The failure is mundane and the consequence is not. A deploy script sends the
 * transaction, the chain mines it, and then the script dies - a dropped RPC
 * connection, a full disk, a closed laptop - before writing the address down.
 * Re-running deploys a SECOND contract. Now two desks exist, only one is
 * configured, funds can arrive at the orphan, and reconciliation compares the
 * wrong pair of ledgers while reporting healthy.
 *
 * The fix is to stop treating the local file as the record of what exists.
 * The chain is the record; the file is a cache of it.
 *
 * A contract address created by an EOA is `keccak256(rlp([sender, nonce]))`,
 * which is knowable BEFORE the transaction is sent. So: predict the address,
 * write the intent down, then deploy. On any later run, look at the chain -
 * if code is already there, adopt it.
 */

export type AdoptionOutcome =
  | { action: "adopt"; address: Address; reason: string }
  | { action: "deploy"; predictedAddress: Address; reason: string };

export interface PendingDeployment {
  /** The address the next deployment from this account would land at. */
  predictedAddress: Address;
  deployer: Address;
  nonce: number;
  chainId: number;
}

/** What the next contract deployed by this account will be called. */
export async function predictDeployment(
  client: PublicClient,
  deployer: Address,
): Promise<PendingDeployment> {
  const [nonce, chainId] = await Promise.all([
    client.getTransactionCount({ address: deployer }),
    client.getChainId(),
  ]);

  return {
    predictedAddress: getContractAddress({ from: deployer, nonce: BigInt(nonce) }),
    deployer,
    nonce,
    chainId,
  };
}

/** True when something is actually deployed at this address. */
export async function hasCode(
  client: PublicClient,
  address: Address,
): Promise<boolean> {
  const code = await client.getCode({ address });
  return code !== undefined && code !== "0x";
}

/**
 * Decide whether to reuse an existing deployment or make a new one.
 *
 * Checked in order of confidence:
 *
 *  1. A recorded address with code at it. The normal resumed run.
 *  2. A recorded address with NO code. The record is wrong - a wiped testnet, a
 *     file copied between environments - so deploy rather than trust it.
 *  3. A pending record from an interrupted run, with code at the predicted
 *     address. This is the crash window, recovered.
 *  4. Nothing known. Deploy.
 */
export async function decideDeployment(
  client: PublicClient,
  deployer: Address,
  record: { address?: Address; pending?: PendingDeployment } = {},
): Promise<AdoptionOutcome> {
  const chainId = await client.getChainId();

  if (record.address) {
    if (await hasCode(client, record.address)) {
      return {
        action: "adopt",
        address: record.address,
        reason: "already deployed and recorded",
      };
    }
    return {
      action: "deploy",
      predictedAddress: (await predictDeployment(client, deployer)).predictedAddress,
      reason:
        `the recorded address ${record.address} has no code on chain ${chainId}; ` +
        "the record is stale, so it is not trusted",
    };
  }

  // The crash window: the transaction may have landed even though nothing was
  // written down. Ask the chain rather than guessing.
  if (record.pending && record.pending.chainId === chainId) {
    if (await hasCode(client, record.pending.predictedAddress)) {
      return {
        action: "adopt",
        address: record.pending.predictedAddress,
        reason:
          "an interrupted run had already deployed this; recovered from the " +
          "predicted address",
      };
    }
  }

  return {
    action: "deploy",
    predictedAddress: (await predictDeployment(client, deployer)).predictedAddress,
    reason: "nothing deployed yet",
  };
}

/**
 * Confirm an adopted contract is the thing we think it is.
 *
 * An address having code proves something is there, not that it is ours. A
 * probe that reads a value only our contract exposes turns "an address I found
 * in a file" into "a contract that behaves like the one I expect".
 */
export async function verifyAdopted<T>(
  probe: () => Promise<T>,
  expected: T,
  description: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const actual = await probe();
    const matches =
      typeof actual === "string" && typeof expected === "string"
        ? actual.toLowerCase() === expected.toLowerCase()
        : actual === expected;

    return matches
      ? { ok: true, detail: `${description} matches` }
      : { ok: false, detail: `${description}: expected ${expected}, found ${actual}` };
  } catch (error) {
    return {
      ok: false,
      detail: `${description}: could not read it (${String(error)})`,
    };
  }
}

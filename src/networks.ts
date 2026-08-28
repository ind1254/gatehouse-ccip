import type { Address } from "viem";

/**
 * CCIP network constants, copied from the official directory.
 *
 * Verified against docs.chain.link on 2026-08-28:
 *   https://docs.chain.link/ccip/directory/testnet
 *
 * These are consensus constants, not opinions. If a value here is wrong, every
 * message goes to the wrong place, so they are kept in one file with their
 * source recorded rather than scattered through scripts.
 */

export interface CcipNetwork {
  name: string;
  chainId: number;
  /** CCIP's own identifier for the chain. Not the EVM chain id. */
  chainSelector: bigint;
  router: Address;
  linkToken: Address;
  /** CCIP-BnM, the standard test token. */
  testToken?: Address;
  explorer: string;
  /**
   * Roughly how long a message out of this chain takes to become executable,
   * dominated by source-chain finality. Used to tell "in flight" from "lost".
   */
  finalitySeconds: number;
}

export const ETHEREUM_SEPOLIA: CcipNetwork = {
  name: "ethereum-sepolia",
  chainId: 11155111,
  chainSelector: 16015286601757825753n,
  router: "0x0BF3dE8c5D3e8A2B34D2BEeB17ABfCeBaf363A59",
  linkToken: "0x779877A7B0D9E8603169DdbD7836e478b4624789",
  testToken: "0xFd57b4ddBf88a4e07fF4e34C487b99af2Fe82a05",
  explorer: "https://sepolia.etherscan.io",
  // Ethereum finality is the slow one: roughly two epochs.
  finalitySeconds: 19 * 60,
};

export const BASE_SEPOLIA: CcipNetwork = {
  name: "base-sepolia",
  chainId: 84532,
  chainSelector: 10344971235874465080n,
  router: "0xD3b06cEbF099CE7DA4AcCf578aaebFDBd6e88a93",
  linkToken: "0xE4aB69C077896252FAFBD49EFD26B5D171A32410",
  // NOTE: not yet filled in. Look up CCIP-BnM for Base Sepolia in the CCIP
  // directory and set it before deploying, rather than trusting a number
  // someone remembered:
  //   https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia-base-1
  testToken: undefined,
  explorer: "https://sepolia.basescan.org",
  finalitySeconds: 15 * 60,
};

export const NETWORKS: Record<string, CcipNetwork> = {
  "ethereum-sepolia": ETHEREUM_SEPOLIA,
  "base-sepolia": BASE_SEPOLIA,
};

/** Where to watch a message travel. */
export const CCIP_EXPLORER = "https://ccip.chain.link";

export function ccipMessageUrl(messageId: string): string {
  return `${CCIP_EXPLORER}/msg/${messageId}`;
}

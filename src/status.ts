import type { Address, PublicClient } from "viem";
import { inboxAbi, outboxAbi } from "./abis.js";
import type { Deployment } from "./reconcile.js";

/// The zero address is the delivery-count bucket, not a token.
export const MESSAGE_COUNT_BUCKET =
  "0x0000000000000000000000000000000000000000" as const;

export interface LimitStatus {
  token: Address;
  enabled: boolean;
  amountPerWindow: bigint;
  windowSeconds: bigint;
  remaining: bigint;
}

export interface DeskStatus {
  address: Address;
  owner: Address;
  guardian: Address;
  paused: boolean;
  limits: LimitStatus[];
}

export interface GatehouseStatus {
  outbox: DeskStatus & { shippedCount: bigint; destinationGasLimit: bigint };
  inbox: DeskStatus & { deliveryCount: bigint; releaseDelay: bigint };
}

async function readLimits(
  client: PublicClient,
  address: Address,
  abi: typeof outboxAbi | typeof inboxAbi,
  tokens: Address[],
): Promise<LimitStatus[]> {
  const buckets = [MESSAGE_COUNT_BUCKET as Address, ...tokens];

  return Promise.all(
    buckets.map(async (token) => {
      const [configured, remaining] = await Promise.all([
        client.readContract({ address, abi, functionName: "limit", args: [token] }),
        client.readContract({
          address,
          abi,
          functionName: "remainingAllowance",
          args: [token],
        }),
      ]);

      const [enabled, amountPerWindow, windowSeconds] = configured as unknown as [
        boolean,
        bigint,
        bigint,
      ];

      return { token, enabled, amountPerWindow, windowSeconds, remaining };
    }),
  );
}

/** A read-only snapshot of both desks: who controls them, and what is capped. */
export async function readStatus(
  client: PublicClient,
  deployment: Deployment,
): Promise<GatehouseStatus> {
  const { outbox, inbox, tokens } = deployment;

  const [
    outboxOwner,
    outboxGuardian,
    outboxPaused,
    shippedCount,
    destinationGasLimit,
    outboxLimits,
    inboxOwner,
    inboxGuardian,
    inboxPaused,
    deliveryCount,
    releaseDelay,
    inboxLimits,
  ] = await Promise.all([
    client.readContract({ address: outbox, abi: outboxAbi, functionName: "owner" }),
    client.readContract({ address: outbox, abi: outboxAbi, functionName: "guardian" }),
    client.readContract({ address: outbox, abi: outboxAbi, functionName: "paused" }),
    client.readContract({ address: outbox, abi: outboxAbi, functionName: "shippedCount" }),
    client.readContract({
      address: outbox,
      abi: outboxAbi,
      functionName: "destinationGasLimit",
    }),
    readLimits(client, outbox, outboxAbi, tokens),
    client.readContract({ address: inbox, abi: inboxAbi, functionName: "owner" }),
    client.readContract({ address: inbox, abi: inboxAbi, functionName: "guardian" }),
    client.readContract({ address: inbox, abi: inboxAbi, functionName: "paused" }),
    client.readContract({ address: inbox, abi: inboxAbi, functionName: "deliveryCount" }),
    client.readContract({ address: inbox, abi: inboxAbi, functionName: "releaseDelay" }),
    readLimits(client, inbox, inboxAbi, tokens),
  ]);

  return {
    outbox: {
      address: outbox,
      owner: outboxOwner,
      guardian: outboxGuardian,
      paused: outboxPaused,
      limits: outboxLimits,
      shippedCount,
      destinationGasLimit,
    },
    inbox: {
      address: inbox,
      owner: inboxOwner,
      guardian: inboxGuardian,
      paused: inboxPaused,
      limits: inboxLimits,
      deliveryCount,
      releaseDelay,
    },
  };
}

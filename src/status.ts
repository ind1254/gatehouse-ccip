import { keccak256, toHex, type Abi, type Address, type PublicClient } from "viem";
import { inboxAbi, outboxAbi } from "./abis.js";
import type { BridgeClients, Deployment } from "./reconcile.js";

/// The zero address is the delivery-count bucket, not a token.
export const MESSAGE_COUNT_BUCKET =
  "0x0000000000000000000000000000000000000000" as const;

/// Lane 0 is the aggregate bucket, consumed alongside every specific lane.
export const ALL_LANES = 0n;

/**
 * Role ids, computed the same way the contracts do.
 *
 * Role holders cannot be enumerated from a mapping, so they are derived from
 * `RoleSet` events instead: fold the log in order, and the last entry for each
 * (role, account) pair is the current state.
 */
export const ROLES = {
  GUARDIAN: keccak256(toHex("GUARDIAN")),
  CONFIG: keccak256(toHex("CONFIG")),
  TREASURY: keccak256(toHex("TREASURY")),
} as const;

export type RoleName = keyof typeof ROLES;

export interface LimitStatus {
  lane: bigint;
  token: Address;
  enabled: boolean;
  capacity: bigint;
  refillAmount: bigint;
  refillPeriod: bigint;
  remaining: bigint;
}

export interface DeskStatus {
  address: Address;
  owner: Address;
  pendingOwner: Address;
  paused: boolean;
  trustDelay: bigint;
  roles: Record<RoleName, Address[]>;
  limits: LimitStatus[];
}

export interface GatehouseStatus {
  outbox: DeskStatus & { shippedCount: bigint; destinationGasLimit: bigint };
  inbox: DeskStatus & { deliveryCount: bigint; releaseDelay: bigint };
}

/** Fold `RoleSet` events into the current holder list for each role. */
async function readRoles(
  client: PublicClient,
  address: Address,
  abi: Abi,
  fromBlock: bigint,
): Promise<Record<RoleName, Address[]>> {
  const logs = await client.getContractEvents({
    address,
    abi,
    eventName: "RoleSet",
    fromBlock,
  });

  const held = new Map<string, Set<string>>();
  for (const name of Object.keys(ROLES)) held.set(name, new Set());

  const byId = new Map(
    Object.entries(ROLES).map(([name, id]) => [id.toLowerCase(), name]),
  );

  for (const log of logs) {
    const args = log.args as {
      role?: string;
      account?: string;
      granted?: boolean;
    };
    const name = byId.get((args.role ?? "").toLowerCase());
    if (!name || !args.account) continue;

    const set = held.get(name);
    if (!set) continue;
    if (args.granted) set.add(args.account.toLowerCase());
    else set.delete(args.account.toLowerCase());
  }

  return {
    GUARDIAN: [...(held.get("GUARDIAN") ?? [])] as Address[],
    CONFIG: [...(held.get("CONFIG") ?? [])] as Address[],
    TREASURY: [...(held.get("TREASURY") ?? [])] as Address[],
  };
}

async function readLimits(
  client: PublicClient,
  address: Address,
  abi: typeof outboxAbi | typeof inboxAbi,
  lane: bigint,
  tokens: Address[],
): Promise<LimitStatus[]> {
  const buckets = [MESSAGE_COUNT_BUCKET as Address, ...tokens];

  // Each bucket is reported on its own lane and on the aggregate lane, because
  // an action consumes both.
  const pairs = buckets.flatMap((token) =>
    lane === ALL_LANES
      ? [{ lane, token }]
      : [
          { lane, token },
          { lane: ALL_LANES, token },
        ],
  );

  return Promise.all(
    pairs.map(async ({ lane: bucketLane, token }) => {
      const [configured, remaining] = await Promise.all([
        client.readContract({
          address,
          abi,
          functionName: "limit",
          args: [bucketLane, token],
        }),
        client.readContract({
          address,
          abi,
          functionName: "remainingAllowance",
          args: [bucketLane, token],
        }),
      ]);

      const [enabled, capacity, refillAmount, refillPeriod] =
        configured as unknown as [boolean, bigint, bigint, bigint];

      return {
        lane: bucketLane,
        token,
        enabled,
        capacity,
        refillAmount,
        refillPeriod,
        remaining,
      };
    }),
  );
}

/** A read-only snapshot of both desks: who controls them, and what is capped. */
export async function readStatus(
  clients: BridgeClients,
  deployment: Deployment,
): Promise<GatehouseStatus> {
  const { outbox, inbox, tokens } = deployment;
  const sourceTokens = tokens.map((pair) => pair.source);
  const destinationTokens = tokens.map((pair) => pair.destination);

  // The outbox caps traffic leaving toward the destination chain; the inbox
  // caps traffic arriving from the source chain.
  const outboundLane = BigInt(deployment.destinationChainSelector ?? 0);
  const inboundLane = BigInt(deployment.sourceChainSelector ?? 0);

  const sourceFrom = deployment.fromBlock?.source ?? 0n;
  const destinationFrom = deployment.fromBlock?.destination ?? 0n;

  const [
    outboxOwner,
    outboxPendingOwner,
    outboxPaused,
    outboxTrustDelay,
    shippedCount,
    destinationGasLimit,
    outboxRoles,
    outboxLimits,
    inboxOwner,
    inboxPendingOwner,
    inboxPaused,
    inboxTrustDelay,
    deliveryCount,
    releaseDelay,
    inboxRoles,
    inboxLimits,
  ] = await Promise.all([
    clients.source.readContract({ address: outbox, abi: outboxAbi, functionName: "owner" }),
    clients.source.readContract({
      address: outbox,
      abi: outboxAbi,
      functionName: "pendingOwner",
    }),
    clients.source.readContract({ address: outbox, abi: outboxAbi, functionName: "paused" }),
    clients.source.readContract({ address: outbox, abi: outboxAbi, functionName: "trustDelay" }),
    clients.source.readContract({ address: outbox, abi: outboxAbi, functionName: "shippedCount" }),
    clients.source.readContract({
      address: outbox,
      abi: outboxAbi,
      functionName: "destinationGasLimit",
    }),
    readRoles(clients.source, outbox, outboxAbi as unknown as Abi, sourceFrom),
    readLimits(clients.source, outbox, outboxAbi, outboundLane, sourceTokens),
    clients.destination.readContract({ address: inbox, abi: inboxAbi, functionName: "owner" }),
    clients.destination.readContract({
      address: inbox,
      abi: inboxAbi,
      functionName: "pendingOwner",
    }),
    clients.destination.readContract({ address: inbox, abi: inboxAbi, functionName: "paused" }),
    clients.destination.readContract({ address: inbox, abi: inboxAbi, functionName: "trustDelay" }),
    clients.destination.readContract({
      address: inbox,
      abi: inboxAbi,
      functionName: "deliveryCount",
    }),
    clients.destination.readContract({
      address: inbox,
      abi: inboxAbi,
      functionName: "releaseDelay",
    }),
    readRoles(clients.destination, inbox, inboxAbi as unknown as Abi, destinationFrom),
    readLimits(clients.destination, inbox, inboxAbi, inboundLane, destinationTokens),
  ]);

  return {
    outbox: {
      address: outbox,
      owner: outboxOwner,
      pendingOwner: outboxPendingOwner,
      paused: outboxPaused,
      trustDelay: outboxTrustDelay,
      roles: outboxRoles,
      limits: outboxLimits,
      shippedCount,
      destinationGasLimit,
    },
    inbox: {
      address: inbox,
      owner: inboxOwner,
      pendingOwner: inboxPendingOwner,
      paused: inboxPaused,
      trustDelay: inboxTrustDelay,
      roles: inboxRoles,
      limits: inboxLimits,
      deliveryCount,
      releaseDelay,
    },
  };
}

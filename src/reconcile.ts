import { parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { inboxAbi, outboxAbi } from "./abis.js";

/**
 * Reconciliation: compare what the source desk says it sent against what the
 * destination desk says it received.
 *
 * This exists because the dangerous failures in a cross-chain system are the
 * SILENT ones. A message delivered to an address with no contract code is
 * reported by CCIP as a success; nothing reverts, no error is emitted, and the
 * only trace is that one desk's books moved and the other's did not. You cannot
 * detect that by watching for errors. You detect it by comparing ledgers.
 *
 * Two things this deliberately does NOT assume:
 *
 *  1. That both desks are on the same chain. On a real deployment the outbox is
 *     on Ethereum Sepolia and the inbox is on Base Sepolia, so every read is
 *     addressed to a specific side.
 *  2. That a message which has not arrived is lost. Cross-chain delivery takes
 *     minutes, dominated by source-chain finality. Every healthy message spends
 *     time "shipped but not received", so age is what separates "not yet" from
 *     "never".
 */

export type Severity = "info" | "warn" | "alarm";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export type MessageState = "in-flight" | "overdue" | "missing" | "settled";

export interface MessageRecord {
  messageId: Hex;
  shippedAtBlock: bigint;
  /** Source-chain timestamp, resolved only for messages that have not arrived. */
  shippedAt?: bigint;
  ageSeconds?: number;
  state: MessageState;
  receiver: Address;
  note: string;
  cargoToken?: Address;
  cargoAmount?: bigint;
  received: boolean;
}

export interface TokenLedger {
  symbol?: string;
  sourceToken: Address;
  destinationToken: Address;
  shipped: bigint;
  received: bigint;
  held: bigint;
  inboxBalance: bigint;
  /** Shipped but not yet credited or held. */
  unsettled: bigint;
  /** The part of `unsettled` explained by messages still within expected latency. */
  inFlight: bigint;
  /** Unsettled beyond what in-flight messages explain. This is the real gap. */
  missing: bigint;
  /** Tokens the desk holds that its own books do not explain. */
  unaccounted: bigint;
  /** How much of `unaccounted` arrived as a mint, rather than a transfer. */
  unaccountedFromMint: bigint;
}

export interface HeldRecord {
  messageId: Hex;
  token: Address;
  amount: bigint;
  releasableAt: bigint;
  released: boolean;
  due: boolean;
}

export interface ReconciliationReport {
  checkedAt: number;
  expectedLatencySeconds: number;
  outboxPaused: boolean;
  inboxPaused: boolean;
  messages: MessageRecord[];
  inFlightMessages: MessageRecord[];
  unsettledMessages: MessageRecord[];
  ledgers: TokenLedger[];
  held: HeldRecord[];
  findings: Finding[];
  /** True when nothing needs a human. */
  healthy: boolean;
}

export interface TokenPair {
  symbol?: string;
  /** The token as it exists on the source chain. */
  source: Address;
  /** The matching token on the destination chain. */
  destination: Address;
}

export interface Deployment {
  outbox: Address;
  inbox: Address;
  tokens: TokenPair[];
  /**
   * How long this lane normally takes end to end. A message younger than this
   * is in flight, not late. Defaults low so local runs stay meaningful; a real
   * deployment sets it from the source chain's finality time.
   */
  expectedLatencySeconds?: number;
  /** First block worth scanning on each side. Never scan before deployment. */
  fromBlock?: { source?: bigint; destination?: bigint };
}

/** Both sides of the bridge. On a local chain, pass the same client twice. */
export interface BridgeClients {
  source: PublicClient;
  destination: PublicClient;
}

/** Past this multiple of expected latency, a message is presumed lost. */
export const MISSING_MULTIPLIER = 3;

const DEFAULT_EXPECTED_LATENCY_SECONDS = 60;

const erc20TransferAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export async function reconcile(
  clients: BridgeClients,
  deployment: Deployment,
): Promise<ReconciliationReport> {
  const { outbox, inbox, tokens } = deployment;
  const expectedLatencySeconds =
    deployment.expectedLatencySeconds ?? DEFAULT_EXPECTED_LATENCY_SECONDS;
  const sourceFrom = deployment.fromBlock?.source ?? 0n;
  const destinationFrom = deployment.fromBlock?.destination ?? 0n;

  const [
    shippedLogs,
    cargoShippedLogs,
    receivedLogs,
    heldLogs,
    releasedLogs,
    outboxPaused,
    inboxPaused,
    sourceBlock,
    destinationBlock,
  ] = await Promise.all([
    clients.source.getContractEvents({
      address: outbox,
      abi: outboxAbi,
      eventName: "DeliveryShipped",
      fromBlock: sourceFrom,
    }),
    clients.source.getContractEvents({
      address: outbox,
      abi: outboxAbi,
      eventName: "CargoShipped",
      fromBlock: sourceFrom,
    }),
    clients.destination.getContractEvents({
      address: inbox,
      abi: inboxAbi,
      eventName: "DeliveryReceived",
      fromBlock: destinationFrom,
    }),
    clients.destination.getContractEvents({
      address: inbox,
      abi: inboxAbi,
      eventName: "CargoHeld",
      fromBlock: destinationFrom,
    }),
    clients.destination.getContractEvents({
      address: inbox,
      abi: inboxAbi,
      eventName: "CargoReleased",
      fromBlock: destinationFrom,
    }),
    clients.source.readContract({ address: outbox, abi: outboxAbi, functionName: "paused" }),
    clients.destination.readContract({ address: inbox, abi: inboxAbi, functionName: "paused" }),
    clients.source.getBlock(),
    clients.destination.getBlock(),
  ]);

  const receivedIds = new Set(receivedLogs.map((log) => log.args.messageId as Hex));
  const receivedTxHashes = new Set(
    receivedLogs.map((log) => (log.transactionHash ?? "0x").toLowerCase()),
  );

  const cargoByMessage = new Map<Hex, { token: Address; amount: bigint }>();
  for (const log of cargoShippedLogs) {
    cargoByMessage.set(log.args.messageId as Hex, {
      token: log.args.token as Address,
      amount: log.args.amount as bigint,
    });
  }

  const messages: MessageRecord[] = shippedLogs.map((log) => {
    const messageId = log.args.messageId as Hex;
    const cargo = cargoByMessage.get(messageId);
    return {
      messageId,
      shippedAtBlock: log.blockNumber ?? 0n,
      state: receivedIds.has(messageId) ? ("settled" as const) : ("in-flight" as const),
      receiver: log.args.receiver as Address,
      note: (log.args.message as string) ?? "",
      cargoToken: cargo?.token,
      cargoAmount: cargo?.amount,
      received: receivedIds.has(messageId),
    };
  });

  // Only messages that have not arrived need an age, so only those cost a
  // block lookup. Timestamps come from the SOURCE chain, where they were sent.
  //
  // "Now" is whichever clock is further ahead: the source chain's latest block,
  // or the wall clock. A chain that has stopped producing blocks would
  // otherwise report every pending message as freshly sent, hiding exactly the
  // outage worth alerting on. Taking the maximum means neither a stalled chain
  // nor a stalled host can make a late message look young.
  const wallClock = BigInt(Math.floor(Date.now() / 1000));
  const nowOnSource =
    sourceBlock.timestamp > wallClock ? sourceBlock.timestamp : wallClock;

  const pending = messages.filter((message) => !message.received);
  await resolveAges(clients.source, pending, nowOnSource, expectedLatencySeconds);

  const inFlightMessages = pending.filter((message) => message.state === "in-flight");
  const unsettledMessages = pending.filter((message) => message.state !== "in-flight");

  const releasedIds = new Set(releasedLogs.map((log) => log.args.messageId as Hex));
  const now = destinationBlock.timestamp;
  const held: HeldRecord[] = heldLogs.map((log) => {
    const messageId = log.args.messageId as Hex;
    const releasableAt = log.args.releasableAt as bigint;
    const released = releasedIds.has(messageId);
    return {
      messageId,
      token: log.args.token as Address,
      amount: log.args.amount as bigint,
      releasableAt,
      released,
      due: !released && now >= releasableAt,
    };
  });

  const ledgers: TokenLedger[] = [];
  for (const pair of tokens) {
    const [shipped, received, heldTotal, inboxBalance] = await Promise.all([
      clients.source.readContract({
        address: outbox,
        abi: outboxAbi,
        functionName: "totalShipped",
        args: [pair.source],
      }),
      clients.destination.readContract({
        address: inbox,
        abi: inboxAbi,
        functionName: "totalReceived",
        args: [pair.destination],
      }),
      clients.destination.readContract({
        address: inbox,
        abi: inboxAbi,
        functionName: "totalHeld",
        args: [pair.destination],
      }),
      clients.destination.readContract({
        address: inbox,
        abi: inboxAbi,
        functionName: "cargoBalance",
        args: [pair.destination],
      }),
    ]);

    const settled = received + heldTotal;
    const unsettled = shipped > settled ? shipped - settled : 0n;

    const inFlight = sumCargo(inFlightMessages, pair.source);
    const missing = unsettled > inFlight ? unsettled - inFlight : 0n;
    const unaccounted = inboxBalance > settled ? inboxBalance - settled : 0n;

    // A balance the books cannot explain has several causes, and they are not
    // equally serious. The token's own Transfer log says which one it was:
    // a mint is tokens coming into existence, which is what an unbacked mint
    // looks like from the destination's point of view.
    const unaccountedFromMint =
      unaccounted > 0n
        ? await sumMintsInto(
            clients.destination,
            pair.destination,
            inbox,
            destinationFrom,
            receivedTxHashes,
          )
        : 0n;

    ledgers.push({
      symbol: pair.symbol,
      sourceToken: pair.source,
      destinationToken: pair.destination,
      shipped,
      received,
      held: heldTotal,
      inboxBalance,
      unsettled,
      inFlight,
      missing,
      unaccounted,
      unaccountedFromMint,
    });
  }

  const findings = buildFindings({
    outboxPaused,
    inboxPaused,
    inFlightMessages,
    unsettledMessages,
    ledgers,
    held,
    expectedLatencySeconds,
  });

  return {
    checkedAt: Number(now),
    expectedLatencySeconds,
    outboxPaused,
    inboxPaused,
    messages,
    inFlightMessages,
    unsettledMessages,
    ledgers,
    held,
    findings,
    healthy: !findings.some((finding) => finding.severity !== "info"),
  };
}

/** Attach a source-chain age to each pending message and classify it. */
async function resolveAges(
  client: PublicClient,
  pending: MessageRecord[],
  nowOnSource: bigint,
  expectedLatencySeconds: number,
): Promise<void> {
  const blockNumbers = [...new Set(pending.map((message) => message.shippedAtBlock))];
  const blocks = await Promise.all(
    blockNumbers.map((blockNumber) => client.getBlock({ blockNumber })),
  );
  const timestamps = new Map(
    blockNumbers.map((blockNumber, index) => [blockNumber, blocks[index].timestamp]),
  );

  for (const message of pending) {
    const shippedAt = timestamps.get(message.shippedAtBlock);
    if (shippedAt === undefined) continue;

    const age = Number(nowOnSource - shippedAt);
    message.shippedAt = shippedAt;
    message.ageSeconds = age;
    message.state =
      age < expectedLatencySeconds
        ? "in-flight"
        : age < expectedLatencySeconds * MISSING_MULTIPLIER
          ? "overdue"
          : "missing";
  }
}

function sumCargo(messages: MessageRecord[], token: Address): bigint {
  let total = 0n;
  for (const message of messages) {
    if (
      message.cargoToken?.toLowerCase() === token.toLowerCase() &&
      message.cargoAmount
    ) {
      total += message.cargoAmount;
    }
  }
  return total;
}

/**
 * Total tokens minted directly to an address, ignoring mints that happened in
 * the same transaction as a recorded delivery.
 *
 * An ERC-20 mint is a Transfer from the zero address, which is exactly what
 * distinguishes "someone sent tokens here" from "tokens were created here".
 */
async function sumMintsInto(
  client: PublicClient,
  token: Address,
  recipient: Address,
  fromBlock: bigint,
  accountedTxHashes: Set<string>,
): Promise<bigint> {
  const logs = await client.getContractEvents({
    address: token,
    abi: erc20TransferAbi,
    eventName: "Transfer",
    args: { from: zeroAddress, to: recipient },
    fromBlock,
  });

  let total = 0n;
  for (const log of logs) {
    const txHash = (log.transactionHash ?? "0x").toLowerCase();
    if (accountedTxHashes.has(txHash)) continue;
    total += (log.args.value as bigint) ?? 0n;
  }
  return total;
}

function buildFindings({
  outboxPaused,
  inboxPaused,
  inFlightMessages,
  unsettledMessages,
  ledgers,
  held,
  expectedLatencySeconds,
}: {
  outboxPaused: boolean;
  inboxPaused: boolean;
  inFlightMessages: MessageRecord[];
  unsettledMessages: MessageRecord[];
  ledgers: TokenLedger[];
  held: HeldRecord[];
  expectedLatencySeconds: number;
}): Finding[] {
  const findings: Finding[] = [];

  if (outboxPaused) {
    findings.push({
      severity: "info",
      code: "OUTBOX_PAUSED",
      message: "The shipping desk is paused. No new shipments can leave.",
    });
  }
  if (inboxPaused) {
    findings.push({
      severity: "info",
      code: "INBOX_PAUSED",
      message:
        "The receiving desk is paused. Arriving deliveries will revert and " +
        "must be re-executed after unpausing.",
    });
  }

  if (inFlightMessages.length > 0) {
    findings.push({
      severity: "info",
      code: "MESSAGES_IN_FLIGHT",
      message:
        `${inFlightMessages.length} message(s) have been shipped and are still ` +
        `within the expected ${expectedLatencySeconds}s delivery window. This ` +
        `is the normal state of every message that has ever worked.`,
    });
  }

  for (const message of unsettledMessages) {
    const carriesCargo = (message.cargoAmount ?? 0n) > 0n;
    const presumedLost = message.state === "missing";

    findings.push({
      severity: presumedLost && carriesCargo ? "alarm" : "warn",
      code: presumedLost ? "MESSAGE_MISSING" : "MESSAGE_OVERDUE",
      message:
        `${message.messageId} was shipped ${message.ageSeconds ?? "?"}s ago ` +
        `(expected within ${expectedLatencySeconds}s) and the receiving desk ` +
        `has not recorded it` +
        (carriesCargo ? `, carrying ${message.cargoAmount} of cargo` : "") +
        `. Check the CCIP explorer: a FAILED message can be manually executed; ` +
        `a message delivered to an address with no contract code cannot.`,
    });
  }

  for (const ledger of ledgers) {
    if (ledger.missing > 0n) {
      findings.push({
        severity: "alarm",
        code: "LEDGER_GAP",
        message:
          `${ledger.sourceToken}: the shipping desk has sent ${ledger.shipped} ` +
          `but the receiving desk accounts for ${ledger.received + ledger.held}, ` +
          `and only ${ledger.inFlight} of the difference is explained by ` +
          `messages still in flight. ${ledger.missing} is unaccounted for.`,
      });
    }

    if (ledger.unaccountedFromMint > 0n) {
      findings.push({
        severity: "alarm",
        code: "UNACCOUNTED_MINT",
        message:
          `${ledger.destinationToken}: ${ledger.unaccountedFromMint} was MINTED ` +
          `directly to the receiving desk outside any recorded delivery. Tokens ` +
          `existing on the destination without a matching burn on the source is ` +
          `what an unbacked mint looks like from this side.`,
      });
    } else if (ledger.unaccounted > 0n) {
      findings.push({
        severity: "warn",
        code: "UNACCOUNTED_BALANCE",
        message:
          `${ledger.destinationToken}: the receiving desk holds ` +
          `${ledger.unaccounted} more than its books explain, and none of it ` +
          `was minted, so it arrived as a plain transfer. Tokens can be sent to ` +
          `an address directly, without a message, so a balance is never proof ` +
          `of a delivery.`,
      });
    }
  }

  for (const record of held) {
    if (record.due) {
      findings.push({
        severity: "warn",
        code: "RELEASE_DUE",
        message:
          `${record.messageId}: ${record.amount} of held cargo passed its ` +
          `release time at ${record.releasableAt} and is still held. ` +
          `Call releaseCargo to settle it.`,
      });
    }
  }

  return findings;
}

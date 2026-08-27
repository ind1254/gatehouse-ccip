import type { Address, Hex, PublicClient } from "viem";
import { inboxAbi, outboxAbi } from "./abis.js";

/**
 * Reconciliation: compare what the source desk says it sent against what the
 * destination desk says it received.
 *
 * This exists because the dangerous failures in a cross-chain system are the
 * SILENT ones. A message delivered to an address with no contract code is
 * reported as a success by CCIP; nothing reverts, no error is emitted, and the
 * only trace is that one desk's books moved and the other's did not. You cannot
 * detect that by watching for errors. You detect it by comparing ledgers.
 */

export type Severity = "info" | "warn" | "alarm";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
}

export interface MessageRecord {
  messageId: Hex;
  shippedAtBlock: bigint;
  receiver: Address;
  note: string;
  cargoToken?: Address;
  cargoAmount?: bigint;
  received: boolean;
}

export interface TokenLedger {
  token: Address;
  shipped: bigint;
  received: bigint;
  held: bigint;
  inboxBalance: bigint;
  /** Shipped but not yet credited or held: in flight, or lost. */
  unsettled: bigint;
  /** Tokens the desk holds that its own books do not explain. */
  unaccounted: bigint;
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
  outboxPaused: boolean;
  inboxPaused: boolean;
  messages: MessageRecord[];
  unsettledMessages: MessageRecord[];
  ledgers: TokenLedger[];
  held: HeldRecord[];
  findings: Finding[];
  /** True when nothing needs a human. */
  healthy: boolean;
}

export interface Deployment {
  outbox: Address;
  inbox: Address;
  tokens: Address[];
}

/**
 * Read both desks and every relevant event, then compare.
 *
 * `fromBlock` defaults to genesis, which is fine for a testnet deployment and
 * for local runs. A production indexer would checkpoint its progress instead of
 * re-reading history on every pass.
 */
export async function reconcile(
  client: PublicClient,
  deployment: Deployment,
  { fromBlock = 0n }: { fromBlock?: bigint } = {},
): Promise<ReconciliationReport> {
  const { outbox, inbox, tokens } = deployment;

  const [
    shippedLogs,
    cargoShippedLogs,
    receivedLogs,
    heldLogs,
    releasedLogs,
    outboxPaused,
    inboxPaused,
    latestBlock,
  ] = await Promise.all([
    client.getContractEvents({
      address: outbox,
      abi: outboxAbi,
      eventName: "DeliveryShipped",
      fromBlock,
    }),
    client.getContractEvents({
      address: outbox,
      abi: outboxAbi,
      eventName: "CargoShipped",
      fromBlock,
    }),
    client.getContractEvents({
      address: inbox,
      abi: inboxAbi,
      eventName: "DeliveryReceived",
      fromBlock,
    }),
    client.getContractEvents({
      address: inbox,
      abi: inboxAbi,
      eventName: "CargoHeld",
      fromBlock,
    }),
    client.getContractEvents({
      address: inbox,
      abi: inboxAbi,
      eventName: "CargoReleased",
      fromBlock,
    }),
    client.readContract({ address: outbox, abi: outboxAbi, functionName: "paused" }),
    client.readContract({ address: inbox, abi: inboxAbi, functionName: "paused" }),
    client.getBlock(),
  ]);

  const receivedIds = new Set(
    receivedLogs.map((log) => log.args.messageId as Hex),
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
      receiver: log.args.receiver as Address,
      note: (log.args.message as string) ?? "",
      cargoToken: cargo?.token,
      cargoAmount: cargo?.amount,
      received: receivedIds.has(messageId),
    };
  });

  const unsettledMessages = messages.filter((message) => !message.received);

  // Held cargo, minus anything already released.
  const releasedIds = new Set(
    releasedLogs.map((log) => log.args.messageId as Hex),
  );
  const now = latestBlock.timestamp;
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
  for (const token of tokens) {
    const [shipped, received, heldTotal, inboxBalance] = await Promise.all([
      client.readContract({
        address: outbox,
        abi: outboxAbi,
        functionName: "totalShipped",
        args: [token],
      }),
      client.readContract({
        address: inbox,
        abi: inboxAbi,
        functionName: "totalReceived",
        args: [token],
      }),
      client.readContract({
        address: inbox,
        abi: inboxAbi,
        functionName: "totalHeld",
        args: [token],
      }),
      client.readContract({
        address: inbox,
        abi: inboxAbi,
        functionName: "cargoBalance",
        args: [token],
      }),
    ]);

    const settled = received + heldTotal;
    ledgers.push({
      token,
      shipped,
      received,
      held: heldTotal,
      inboxBalance,
      unsettled: shipped > settled ? shipped - settled : 0n,
      unaccounted: inboxBalance > settled ? inboxBalance - settled : 0n,
    });
  }

  const findings = buildFindings({
    outboxPaused,
    inboxPaused,
    unsettledMessages,
    ledgers,
    held,
  });

  return {
    checkedAt: Number(now),
    outboxPaused,
    inboxPaused,
    messages,
    unsettledMessages,
    ledgers,
    held,
    findings,
    healthy: !findings.some((finding) => finding.severity !== "info"),
  };
}

function buildFindings({
  outboxPaused,
  inboxPaused,
  unsettledMessages,
  ledgers,
  held,
}: {
  outboxPaused: boolean;
  inboxPaused: boolean;
  unsettledMessages: MessageRecord[];
  ledgers: TokenLedger[];
  held: HeldRecord[];
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

  for (const message of unsettledMessages) {
    const carriesCargo = (message.cargoAmount ?? 0n) > 0n;
    findings.push({
      severity: carriesCargo ? "alarm" : "warn",
      code: "UNSETTLED_MESSAGE",
      message:
        `${message.messageId} left the shipping desk but the receiving desk ` +
        `never recorded it` +
        (carriesCargo ? ` (carrying ${message.cargoAmount} of cargo)` : "") +
        `. Either it is still in flight, or it was delivered to an address ` +
        `that cannot receive it.`,
    });
  }

  for (const ledger of ledgers) {
    if (ledger.unsettled > 0n) {
      findings.push({
        severity: "alarm",
        code: "LEDGER_GAP",
        message:
          `${ledger.token}: the shipping desk has sent ${ledger.shipped} but ` +
          `the receiving desk only accounts for ${ledger.received + ledger.held}. ` +
          `${ledger.unsettled} is unaccounted for.`,
      });
    }
    if (ledger.unaccounted > 0n) {
      findings.push({
        severity: "warn",
        code: "UNACCOUNTED_BALANCE",
        message:
          `${ledger.token}: the receiving desk holds ${ledger.unaccounted} more ` +
          `than its books explain. Tokens can be sent to an address directly, ` +
          `without a message, so a balance is never proof of a delivery.`,
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

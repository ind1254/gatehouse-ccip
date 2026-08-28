import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Abi, Address, PublicClient } from "viem";

/**
 * A durable, resumable log index.
 *
 * Reading every log from the deployment block on every run works locally and
 * fails on a real network for three separate reasons:
 *
 *  1. The cost grows with the age of the chain, not with your usage. A bridge
 *     that ships one message a week still has a reconciler that gets slower
 *     every day.
 *  2. Providers cap `eth_getLogs` by block range - commonly 10,000 blocks - and
 *     rate-limit on top. Past that ceiling the request does not get slow, it
 *     gets REJECTED, and a monitor that is down looks exactly like a system
 *     with no findings.
 *  3. The newest blocks are not settled. Logs read from them can disappear.
 *
 * So: fetch in bounded chunks, persist progress after every chunk, resume from
 * the checkpoint, and never advance past a confirmations buffer.
 *
 * Reorg ROLLBACK - detecting that an already-processed block was replaced and
 * replaying from before it - is deliberately not here. The buffer makes it
 * unlikely; it does not make it impossible. That is the next piece of work, and
 * saying so is more useful than implying this is safe against reorgs.
 */

/** Chosen to sit under the common provider ceiling rather than at it. */
export const DEFAULT_CHUNK_SIZE = 9_000n;

/** Blocks held back from the checkpoint, so unsettled logs are not committed. */
export const DEFAULT_CONFIRMATIONS = 12n;

export interface IndexerConfig {
  /** Where progress is persisted. One file per indexed contract. */
  statePath: string;
  chunkSize?: bigint;
  confirmations?: bigint;
}

/** A log row, flattened so it survives a round trip through JSON. */
export interface IndexedLog {
  eventName: string;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: string;
  args: Record<string, unknown>;
}

export interface IndexState {
  version: 1;
  chainId: number;
  address: Address;
  fromBlock: bigint;
  /** Every block up to and including this one has been indexed. */
  lastProcessedBlock: bigint;
  logs: IndexedLog[];
  updatedAt: number;
}

export interface SyncResult {
  logs: Record<string, IndexedLog[]>;
  state: IndexState;
  /** Blocks read this run. Zero on a second run with no new blocks. */
  blocksScanned: bigint;
  /** Requests issued this run. Useful for proving the checkpoint works. */
  chunksFetched: number;
}

// --------------------------------------------------------------- persistence

/**
 * BigInt has no JSON representation, so tag it rather than guessing on the way
 * back in. Guessing - "does this string look like a number?" - would silently
 * corrupt an address or a hash that happens to be all digits.
 */
function replacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? { __bigint: value.toString() } : value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    typeof value === "object" &&
    value !== null &&
    "__bigint" in value &&
    typeof (value as { __bigint: unknown }).__bigint === "string"
  ) {
    return BigInt((value as { __bigint: string }).__bigint);
  }
  return value;
}

export function loadState(statePath: string): IndexState | undefined {
  try {
    return JSON.parse(readFileSync(resolve(statePath), "utf8"), reviver) as IndexState;
  } catch {
    return undefined;
  }
}

/**
 * Write via a temporary file and rename.
 *
 * A crash midway through a plain write leaves a truncated file, which on the
 * next run parses as "no checkpoint" and silently rescans from the beginning -
 * or worse, parses partially. Rename is atomic on every filesystem this runs on.
 */
export function saveState(statePath: string, state: IndexState): void {
  const target = resolve(statePath);
  mkdirSync(dirname(target), { recursive: true });

  const temporary = `${target}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, replacer, 2)}\n`);
  renameSync(temporary, target);
}

// --------------------------------------------------------------------- sync

function logKey(log: IndexedLog): string {
  return `${log.transactionHash}:${log.logIndex}`;
}

function groupByEvent(logs: IndexedLog[]): Record<string, IndexedLog[]> {
  const grouped: Record<string, IndexedLog[]> = {};
  for (const log of logs) {
    (grouped[log.eventName] ??= []).push(log);
  }
  return grouped;
}

/**
 * Bring the index up to the safe head and return everything known.
 *
 * Safe to call repeatedly: a second call with no new blocks fetches nothing.
 * Safe to interrupt: progress is committed after each chunk, so a crash costs
 * at most one chunk of work and never produces duplicates.
 */
export async function syncContractLogs(
  client: PublicClient,
  target: {
    address: Address;
    abi: Abi;
    eventNames: string[];
    /** The block the contract was deployed in. Nothing before it can match. */
    fromBlock: bigint;
  },
  config: IndexerConfig,
): Promise<SyncResult> {
  const chunkSize = config.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const confirmations = config.confirmations ?? DEFAULT_CONFIRMATIONS;

  const [chainId, head] = await Promise.all([
    client.getChainId(),
    client.getBlockNumber(),
  ]);

  // Discard a checkpoint that belongs to a different contract or chain rather
  // than resuming against it, which would mix two deployments' histories.
  const existing = loadState(config.statePath);
  const reusable =
    existing !== undefined &&
    existing.chainId === chainId &&
    existing.address.toLowerCase() === target.address.toLowerCase() &&
    existing.fromBlock === target.fromBlock;

  let state: IndexState = reusable
    ? existing
    : {
        version: 1,
        chainId,
        address: target.address,
        fromBlock: target.fromBlock,
        lastProcessedBlock: target.fromBlock - 1n,
        logs: [],
        updatedAt: Date.now(),
      };

  // Never commit logs from blocks that could still be reorganised away.
  //
  // Deliberately allowed to go negative. Clamping to zero would treat block 0 -
  // a real block - as safe on a chain too young to have any settled blocks at
  // all, and index it.
  const safeHead = head - confirmations;

  let cursor = state.lastProcessedBlock + 1n;
  let chunksFetched = 0;
  const scannedFrom = cursor;

  const seen = new Set(state.logs.map(logKey));

  while (cursor <= safeHead) {
    const chunkEnd = cursor + chunkSize - 1n > safeHead ? safeHead : cursor + chunkSize - 1n;

    for (const eventName of target.eventNames) {
      const logs = await client.getContractEvents({
        address: target.address,
        abi: target.abi,
        eventName,
        fromBlock: cursor,
        toBlock: chunkEnd,
      });

      for (const log of logs) {
        const row: IndexedLog = {
          eventName,
          blockNumber: log.blockNumber ?? 0n,
          logIndex: log.logIndex ?? 0,
          transactionHash: log.transactionHash ?? "0x",
          args: (log.args ?? {}) as Record<string, unknown>,
        };

        // A chunk boundary can be re-read after a crash, so dedupe rather than
        // trusting that every append is new.
        const key = logKey(row);
        if (seen.has(key)) continue;
        seen.add(key);
        state.logs.push(row);
      }
      chunksFetched += 1;
    }

    state.lastProcessedBlock = chunkEnd;
    state.updatedAt = Date.now();

    // Commit after every chunk, not at the end. A crash then costs one chunk.
    saveState(config.statePath, state);

    cursor = chunkEnd + 1n;
  }

  return {
    logs: groupByEvent(state.logs),
    state,
    blocksScanned: cursor > scannedFrom ? cursor - scannedFrom : 0n,
    chunksFetched,
  };
}

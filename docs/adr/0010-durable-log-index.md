# ADR 0010: A resumable log index, not a rescan

**Status:** accepted
**Date:** 2026-08-28

## Context

Reconciliation read every log from the deployment block on every run. That is
fine against one local node and wrong against a real network, for three separate
reasons:

1. **Cost grows with the age of the chain, not with usage.** Sepolia produces
   ~7,200 blocks a day. A bridge shipping one message a week still has a
   reconciler that gets more expensive every day.
2. **Providers reject oversized ranges.** `eth_getLogs` is commonly capped at
   10,000 blocks, with rate limits on top. Past the ceiling the request does not
   get slow, it **fails** - and a monitor that is down looks exactly like a
   system with no findings.
3. **The newest blocks are not settled.** Logs read from them can disappear.

## Decision

A durable index in [`src/indexer.ts`](../../src/indexer.ts):

- **Bounded chunks.** Default 9,000 blocks, deliberately under the common
  ceiling rather than at it.
- **A persisted checkpoint**, committed after *every chunk*, so a crash costs at
  most one chunk of work.
- **A confirmations buffer.** The checkpoint never advances past
  `head - confirmations`, so unsettled logs are not committed.
- **Deduplication** on `transactionHash:logIndex`, because a chunk boundary can
  be re-read after a crash.
- **Atomic writes**, temp-then-rename: a torn state file reads back as "no
  checkpoint" and would silently rescan from the beginning.
- **A checkpoint is discarded if it belongs to a different contract or chain**,
  rather than resumed against — mixing two deployments' histories would corrupt
  every ledger comparison while still producing a confident-looking report.

BigInts are tagged on the way out (`{"__bigint":"123"}`) rather than inferred on
the way back in. Guessing — "does this string look like a number?" — would
silently corrupt an address or hash that happens to be all digits.

The indexed and direct readers return identical rows, so nothing downstream knows
which was used. That is what makes it safe to run the indexed path in production
and the direct path in tests, and it is asserted:
`produces the same report either way`.

## Consequences

`reconcile` takes an optional `index` option; the CLI exposes `--index-dir`.
Without it, behaviour is exactly as before, so no existing test changes meaning.

**Reorg rollback is deliberately not here.** Detecting that an already-processed
block was replaced, and replaying from before it, is the next piece of work. The
confirmations buffer makes a reorg unlikely to be committed; it does not make it
impossible. Saying so is more useful than implying this is reorg-safe.

The ERC-20 `Transfer` scan used for mint detection still reads directly from the
deployment block. It is the obvious next thing to move behind the index.

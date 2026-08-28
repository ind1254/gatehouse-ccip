# ADR 0009: The chain is the record of what exists; the file is a cache

**Status:** accepted
**Date:** 2026-08-28

## Context

The first deploy script read `deployments/testnet.json`, then called
`deployContract` unconditionally. Two failures follow from that, and the second
one is quiet.

**A rerun redeploys.** Anyone re-running the script gets a second contract, even
though the first is fine.

**A crash between the transaction and the write orphans a contract.** The
transaction lands, the process dies - dropped connection, closed laptop, full
disk - and nothing is written down. The next run deploys again. Now two desks
exist, only one is configured, funds can arrive at the orphan, and
reconciliation compares the wrong pair of ledgers **while reporting healthy**.
That is the same failure shape as everything else here: it looks fine and
quietly is not.

The configure script had the matching problem: twelve unconditional writes,
costing twelve transactions to change nothing, with no way to see what it would
do before it did it.

## Decision

**Treat the chain as the source of truth and the file as a cache of it.**

Before deploying, ask the chain, in order of confidence:

1. A recorded address with code at it → adopt.
2. A recorded address with **no** code → the record is stale (a wiped testnet, a
   file copied between environments). Do not trust it; deploy.
3. A *pending* record from an interrupted run, with code at the predicted
   address → the crash window, recovered.
4. Nothing known → deploy.

Case 3 is the interesting one, and it works because a CREATE address is
`keccak256(rlp([sender, nonce]))` - **knowable before the transaction is sent**.
So the script predicts the address, writes that intent down, and only then
deploys. A later run can find the contract even though nothing recorded its
success.

Adoption is verified rather than assumed: code at an address proves something is
there, not that it is ours, so the script reads back the configured router and
refuses to adopt on a mismatch.

Configuration became a **desired state** rather than a script of transactions.
Each step declares what it wants, how to read what is current, and how to change
it; `converge()` applies only the differences.

## Consequences

Running deploy twice deploys once. Running configure twice sends nothing the
second time — and "nothing to do" is a far more useful thing to see than twelve
successful transactions that changed nothing.

`--dry-run` prints the plan without sending, which makes "is production
configured the way we think it is?" a question that can actually be asked.

A step whose current value cannot be read is treated as **needing a change**,
not skipped. Silently doing nothing is the failure this module exists to prevent.

Ordering is preserved: limits and thresholds are declared before the allowlist
entries that make shipping possible, so a run that stops half way cannot leave a
desk live with no caps on it ([ADR 0005](0005-configure-limits-before-allowlists.md)).

The deployment file is written temp-then-rename, because a torn write reads back
as "no record" and would trigger exactly the redeploy this is meant to stop.

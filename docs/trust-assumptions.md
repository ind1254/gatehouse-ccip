# Trust assumptions

Things this system takes on faith. Each one is stated with what breaks if it
turns out to be false, because an assumption you have not written down is one
you cannot check.

---

## A1. CCIP delivers honestly

We assume the router and the Chainlink DON deliver messages unmodified, report
`sourceChainSelector` and `sender` truthfully, and do not fabricate deliveries.

**Why it is reasonable.** That is the product. Verifying it ourselves would mean
reimplementing cross-chain consensus, which is the thing we chose to use CCIP
instead of building.

**If false.** Total compromise. Every gate in the inbox reasons from
`message.sender` and `message.sourceChainSelector`; if those can be forged, the
allowlist is decoration.

**What we do anyway.** We never trust the *payload*, only the envelope. The
sender is authenticated; the contents are treated as data throughout.

## A2. The destination chain cannot see the source chain

Not an assumption so much as a fact, but it drives the design so it belongs here.
The inbox has no way to verify that a burn happened, that a message was paid for,
or that the source desk's books say what the message claims.

**Consequence.** No on-chain check can catch an unbacked mint (T7). Detection
must live off-chain, comparing two ledgers. That is why reconciliation is a
first-class feature and not a reporting convenience.

## A3. The cargo token behaves like a standard ERC-20

We assume `transfer` and `transferFrom` move exactly the requested amount, and
that a mint appears as a `Transfer` from the zero address.

**If false.** Fee-on-transfer or rebasing tokens would break the accounting
silently — `totalReceived` would record an amount the desk never actually got.
The token allowlist is what keeps this assumption enforceable: only tokens we
have checked are shippable.

**Not handled.** There is no test for a fee-on-transfer token. If this project
ever accepted arbitrary tokens, that would be the first thing to add.

## A4. Source and destination are not atomic

On real CCIP the source transaction **commits and is never rolled back** by a
destination failure. The message is left in a FAILED state pending manual
execution.

**Where this bites.** The local simulator collapses both sides into one
transaction, so a destination revert appears to unwind the source. Tests that
look like they prove bridge atomicity prove only that the *destination
transaction* is atomic. That distinction is called out in
[invariants.md](invariants.md#i3-a-rejected-delivery-leaves-nothing-behind) and
in the README, because reading it the other way would be a genuine
misunderstanding of the system.

**Consequence.** "Shipped but not received" is a real, normal, long-lived state
that has to be managed — not an impossibility. Hence the latency-aware
severities in I9.

## A5. Source-chain finality dominates delivery time

We assume a message takes roughly the source chain's finality time to become
executable: about 13–19 minutes out of Ethereum.

**If false — too low.** Healthy messages get reported as overdue, and the alert
channel loses credibility (see "operator attention" in the threat model).

**If false — too high.** Genuinely lost cargo sits unreported for longer than it
should.

**How it is handled.** `expectedLatencySeconds` is per-deployment configuration
rather than a constant in the code, and severity is a ramp rather than a
threshold, so being somewhat wrong degrades gracefully instead of flipping.

## A6. The monitoring host's clock is roughly correct

Message age is computed against the later of the source chain's latest block
timestamp and the wall clock.

**If the chain stalls.** Wall clock keeps ageing messages, so a stopped chain
does not hide overdue deliveries.

**If the host's clock is fast.** Healthy messages are reported as overdue. A
false positive.

**The trade is deliberate.** Both clocks must be behind for a late message to
look young. This errs toward alerting, which is the correct direction for a tool
whose job is catching silent failures — but it does accept false positives from a
skewed host in exchange.

## A7. The admin keys are split, and somebody is watching

Powers are separated into guardian, config and treasury, the owner has no
implicit bypass, and widening changes must be scheduled and wait out
`trustDelay`. Two assumptions are buried in that.

**That the roles were actually split.** A fresh deployment puts all three on the
deployer and sets `trustDelay` to zero. Nothing forces an operator to separate
them, so a deployment that skips that step has none of this protection while
appearing to.

**That someone reacts inside the delay.** A scheduled widening emits
`ActionScheduled` and a guardian can cancel it — but only if somebody sees it.
An unwatched delay is a speed bump, not a control.

**If false.** Total loss, as before. The delay changes the shape of T5 from
instant to observable; it does not remove it. A multisig owner and alerting on
`ActionScheduled` are the remaining work.

## A8. RPC providers answer truthfully and completely

The reconciler believes what its RPC endpoints tell it about logs and state.

**If false.** A provider that silently truncates a log range makes the ledgers
appear to agree — the "quietly wrong monitor" of T9.

**Partly handled.** Scanning starts at each contract's recorded deployment block,
never genesis. With `--index-dir`, reads are also chunked well under the common
10,000-block provider ceiling and resume from a persisted checkpoint, so the
request that gets *rejected* for being too large never happens.

**Not handled: a single provider is still believed on its word.** There is no
second endpoint to cross-check against, no detection of a provider that
disagrees with its peers, and no failover. That is the next piece of work and
the most valuable remaining item.

## A8b. Recent blocks will not be reorganised out from under the index

The index holds back `confirmations` blocks (default 12) before committing a
checkpoint, so logs from unsettled blocks are not recorded as final.

**If false.** A reorg deeper than the buffer replaces a block the index already
committed. Nothing detects it: there is **no block-hash tracking and no
rollback**. The index would carry a log for a transaction that no longer
exists, and the ledgers would disagree for a reason the tooling cannot explain.

**Why it is like this.** The buffer makes it unlikely, not impossible.
Distinguishing observed from confirmed from finalised — and replaying from
before a replaced block — is real work and is stated as outstanding rather than
implied to be done.

## A9. Testnet only

Nothing here has been audited. The contracts have never held anything of value
and should not. The deployment guide specifies a throwaway wallet for exactly
this reason.

**If violated.** Every residual risk in the threat model becomes a real loss
rather than a lesson.

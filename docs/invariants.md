# Invariants

Properties this system is supposed to hold, and the test that asserts each one.

An invariant with no test beside it is a hope. Where something is **not** tested,
or is tested only weakly, that is stated rather than glossed over — an honest
gap is more useful to a reviewer than a confident claim they can disprove in
five minutes.

Test names are quoted exactly. `test/DocsMatchTests.ts` fails the suite if any
name quoted here stops existing, so this document cannot rot quietly.

---

## I1. A message settles at most once

Once the inbox has acted on a `messageId`, it will never act on it again.

```solidity
if (processedMessages[message.messageId]) revert MessageAlreadyProcessed(...);
processedMessages[message.messageId] = true;
```

- ✅ `acts on a messageId once and refuses it forever after`
- ✅ `still accepts a different messageId carrying the same words`

The second test is the important half. This invariant is about **identity, not
content**: fifty deliveries carrying identical text are fifty distinct messages
and all fifty are legitimate. Replay protection stops duplication; it says
nothing about volume. That is what I5 is for.

## I2. Only an authenticated source can change destination state

A delivery must clear three gates before it touches any state:

| Gate | Question |
|---|---|
| `onlyRouter` | Did this arrive through CCIP at all? |
| `allowedSourceWarehouse[chain][sender]` | Do we trust that contract, on that chain? |
| `processedMessages` | Have we acted on it before? |

- ✅ `rejects a delivery that did not come through the router`
- ✅ `refuses a rogue warehouse, even though the real router delivered it`
- ✅ `names the rejected source when the router speaks to it directly`
- ✅ `refuses a trusted warehouse arriving from the wrong chain`
- ✅ `lets the owner revoke a warehouse it previously trusted`

The allowlist is keyed by the **(chain selector, address) pair**. Two independent
lists would accept a trusted address arriving from an untrusted chain, and an
address is not a unique identity across chains.

## I3. A rejected delivery leaves nothing behind

If any gate refuses a delivery, no state changes and no tokens move. A revert
unwinds the whole transaction, including the token transfer CCIP performed on the
way in.

- ✅ `moves no tokens when the inbox refuses the delivery`
- ✅ `consumes nothing when a paused inbox refuses a delivery`

The second test also proves the corollary that makes rejection *safe*: because
nothing was consumed, the same message can be delivered successfully later. A
rejected message is deferred, not destroyed.

**Scope limit — this is a destination-transaction property, not a bridge
property.** See [trust-assumptions.md](trust-assumptions.md#a4-source-and-destination-are-not-atomic).

## I4. Cargo is conserved across a transfer

Tokens move; they are not created or destroyed.

- ⚠️ `conserves the token supply across the transfer`

**Weakly tested, and the weakness matters.** Chainlink's local simulator moves
cargo with a direct `transferFrom` rather than through token pools, so supply is
constant here because *nothing is minted or burned at all*. That is a much weaker
claim than a burn/mint invariant. A real supply-conservation proof needs token
pools on live testnets. See [adr/0001-transfer-not-burn-mint.md](adr/0001-transfer-not-burn-mint.md).

## I5. No sender can exceed its rate limit, and no boundary can be burst

Rate limits bound behaviour regardless of who is asking, including a sender that
is authenticated, allowlisted, and compromised. A token bucket — burst capacity
plus continuous refill — has no window boundary to exploit.

- ✅ `caps how many deliveries fit in one window`
- ✅ `caps how much cargo leaves in one window`
- ✅ `bounds a compromised but still-allowlisted sender at the inbox`
- ✅ `refills continuously instead of resetting`
- ✅ `grants a partial refill part-way through a period`
- ✅ `never accrues past its capacity, however long it idles`
- ✅ `treats an unconfigured limit as no limit`

Budgets are keyed by **(lane, token)**, with an aggregate bucket consumed
alongside the specific one, so one lane cannot spend another's allowance and a
global cap still bounds the total:

- ✅ `does not let one lane spend another lane's budget`
- ✅ `bounds the total across every lane with the aggregate bucket`

A limit that has never been configured is **unlimited**, not zero. That is why
deployment configures limits before allowlists, and why *disabling* a limit
counts as widening. See
[adr/0007-token-bucket-over-fixed-window.md](adr/0007-token-bucket-over-fixed-window.md).

## I6. A pause stops new exposure without corrupting in-flight state

Pausing must be safe to do mid-incident. It stops new activity, freezes value
that is part-way through the system, and loses nothing.

- ✅ `lets the guardian stop new shipments immediately`
- ✅ `consumes nothing when a paused inbox refuses a delivery`
- ✅ `freezes held cargo while the desk is paused`

The third is the one that makes the pause meaningful. A hold that matures *during*
an incident does not settle: if release could complete while paused, an attacker
would simply wait out the delay while responders worked.

## I7. No single key can both widen trust and move funds

- ✅ `lets only the owner change who is trusted`
- ✅ `refuses a stranger at the emergency stop`
- ✅ `does not let the guardian restart the bridge`
- ✅ `refuses a stranger who is not an authorised shipper`
- ✅ `refuses a shipper aiming at an unapproved receiving desk`
- ✅ `lets the treasury role move received cargo and refuses everyone else`

Powers are split three ways — guardian (pause), config (trust and limits) and
treasury (withdraw) — and the owner has **no implicit bypass**:

- ✅ `does not let a config admin move funds`
- ✅ `does not let a treasurer decide who is trusted`
- ✅ `gives the owner no implicit bypass of the treasury role`
- ✅ `hands ownership over in two steps`

To withdraw, an owner must first grant itself the treasury role — and granting is
a widening change, so that escalation is announced rather than instant.

Stopping is a reflex and belongs on a hot key. Restarting is a judgment and stays
with the owner. See [adr/0004-split-guardian-and-owner.md](adr/0004-split-guardian-and-owner.md)
and [adr/0008-separated-powers-and-asymmetric-timelock.md](adr/0008-separated-powers-and-asymmetric-timelock.md).

## I7b. Widening waits; tightening never does

A change that grants trust, raises a cap, or shortens a delay must be announced
and wait out `trustDelay`. A change that revokes, lowers, or lengthens applies
immediately, because making a system stricter is always safe to do now.

- ✅ `refuses to widen trust without a scheduled action`
- ✅ `still revokes trust immediately`
- ✅ `waits out the delay, then executes exactly the scheduled call`
- ✅ `lets a guardian cancel a widening before it matures`
- ✅ `delays raising a limit but not lowering one`

The action id is the calldata itself, so a schedule authorises exactly one call
with exactly one set of arguments, and it is consumed on use.

## I8. Held cargo cannot be withdrawn or settled early

- ✅ `holds a large delivery and refuses to settle it early`
- ✅ `releases held cargo once the delay expires, for anyone who asks`
- ✅ `settles a small delivery immediately`

`withdrawCargo` subtracts held cargo from what is withdrawable, so the owner
cannot reach around the delay by moving the tokens it guards. Release is
permissionless because a delay that needs permission to end is not a delay — see
[adr/0003-permissionless-release.md](adr/0003-permissionless-release.md).

## I9. Every shipment eventually settles, or is visibly unsettled

The system never quietly loses a message. Anything that does not arrive shows up
in reconciliation, with severity that reflects how long it has been missing.

- ✅ `treats a fresh unsettled message as in flight, not as a fault`
- ✅ `escalates to a warning once it passes the expected latency`
- ✅ `escalates to an alarm once it is far past due`
- ✅ `catches the failure CCIP reported as a success`
- ✅ `records how old an unsettled message is`

**This is the invariant the whole monitoring layer exists to enforce**, because
the dangerous failures here are silent. Cargo delivered to an address with no
contract code is reported by CCIP as a success — see
`silently strands cargo sent to an address with no contract code`.

## I10. A balance is never taken as proof of a delivery

The desk's books and the desk's balance are separate facts, and any divergence
is classified rather than assumed away.

- ✅ `keeps totalReceived in step with the desk's real balance`
- ✅ `reports a balance the books cannot explain`
- ✅ `reports a plain transfer in as unaccounted, but only a warning`
- ✅ `raises an alarm when the tokens were minted straight to the desk`
- ✅ `does not flag mints that arrived as part of a recorded delivery`

Anyone can raise `balanceOf(inbox)` with a plain transfer; no contract code runs.
The token's own `Transfer` log distinguishes a donation from a counterfeit — a
mint is a transfer from the zero address.

## I11. Untrusted chain text never becomes an instruction

Message notes are attacker-chosen text that crossed a chain. Nothing downstream
may act on their contents.

- ✅ `flattens the newlines an injection needs to fake structure`
- ✅ `strips control characters entirely`
- ✅ `caps how much attacker-controlled text it will repeat`
- ✅ `sanitises before fencing, so the fence cannot be broken by a newline`

Sanitising is a courtesy to a careful reader. The **real** control is that the
MCP server holds no key and exposes no tool that can send a transaction. See
[adr/0002-read-only-tooling.md](adr/0002-read-only-tooling.md).

## I12. Monitoring reports a deliberate action as information, not as a fault

- ✅ `reports a paused desk without calling it a failure`
- ✅ `flags a hold that has matured and is still sitting there`

A pause is a live operator choice with no outstanding obligation. A matured hold
is a deadline the system set itself and has not met. Alert fatigue is a security
failure: if planned actions page someone, pages stop meaning anything.

---

## I13. Deploying and configuring twice does the work once

Both are safe to re-run, because in practice they will be. The chain is the
record of what exists; the deployment file is a cache of it.

- ✅ `adopts a contract that is already recorded and really there`
- ✅ `redeploys when the recorded address has no code`
- ✅ `recovers a deployment whose transaction landed but was never recorded`
- ✅ `deploys when a pending intent never actually landed`
- ✅ `refuses to adopt something that is not our contract`
- ✅ `applies only what differs, then nothing at all`
- ✅ `resumes after a step fails part way through`
- ✅ `treats an unreadable step as needing a change rather than skipping it`

The recovery case works because a CREATE address is knowable *before* the
transaction is sent, so intent can be written down first. See
[adr/0009-chain-is-the-record-of-what-exists.md](adr/0009-chain-is-the-record-of-what-exists.md).

## I14. Reading the chain resumes; it does not start over

With an index configured, reconciliation reads in bounded chunks from a
persisted checkpoint, and never commits blocks that could still be reorganised.

- ✅ `does no work at all on a second run with no new blocks`
- ✅ `picks up only what is new`
- ✅ `splits the range into bounded chunks`
- ✅ `resumes from a partially written index without duplicating`
- ✅ `starts over rather than resuming against a different contract`
- ✅ `writes state atomically, so a torn file is never observed`
- ✅ `does not commit logs from blocks that could still be reorganised`
- ✅ `produces the same report either way`

That last test is what makes the whole thing safe: the indexed and direct
readers return identical rows, so nothing downstream can tell which was used.
See [adr/0010-durable-log-index.md](adr/0010-durable-log-index.md).

## Not yet invariants

Stated plainly, because a reviewer will look for them:

| Property | Status |
|---|---|
| Aggregate supply constant across chains under burn/mint | Not provable locally; needs token pools on testnet |
| Source and destination transactions are atomic | **False by design** on real CCIP |
| A single key cannot cause total loss | **False today** — one owner controls both desks |
| Fuzz and formal invariant testing | Not written; all tests are example-based |
| Reorg detection and rollback | **Not implemented.** A confirmations buffer only makes a deep reorg unlikely |
| Cross-checking a second RPC provider | Not implemented; one endpoint is believed on its word |

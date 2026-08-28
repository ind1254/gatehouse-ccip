# Failure runbook

What to do when reconciliation reports something. Written to be followed at 3am
by someone who did not build this.

**First principle: a pause is cheap and reversible. A lost token is not.** When
in doubt, pause and then investigate.

```bash
npm run gatehouse -- reconcile --deployment deployments/testnet.json \
  --rpc <sepolia-rpc> --dest-rpc <base-sepolia-rpc>
```

Exit `0` healthy, `1` needs a human. Add `--json` for machine output.

---

## Stopping the bridge

The console **cannot** do this — it holds no key ([ADR 0002](adr/0002-read-only-tooling.md)).
Pausing is a signed transaction from the guardian or the owner.

```solidity
outbox.pause()   // no new shipments leave
inbox.pause()    // arriving deliveries revert; held cargo stops maturing
```

Pausing the **inbox** during an incident is safe:

- Arriving deliveries revert. They are **not lost** — the revert consumes
  nothing, so each can be executed again after unpausing.
- Held cargo freezes in place: not settled, not withdrawable, not lost.

Only the owner can unpause, and only once the incident is understood.

---

## By finding

### `MESSAGES_IN_FLIGHT` — info

Normal. Every healthy message passes through this state.

Act only if the count keeps climbing and never drains, which means the lane is
stuck rather than slow.

### `MESSAGE_OVERDUE` — warn

Past the lane's expected latency, not yet presumed lost.

1. Open the message on the [CCIP explorer](https://ccip.chain.link).
2. If **FAILED**, find out why before re-executing:
   - inbox paused?
   - rate-limit window exhausted? (`gatehouse status`)
   - source warehouse still allowlisted?
   - `destinationGasLimit` too small for the receiver as it stands now?
3. Fix the cause, then manually execute the message.
4. If still **in flight**, the lane is slow. Compare against
   `expectedLatencySeconds` — the configured expectation may simply be too low.

Nothing is lost at this stage.

### `MESSAGE_MISSING` — alarm

Far past due. Treat as lost until proven otherwise.

1. **Check whether the receiver address has contract code.** If it does not, the
   cargo is gone permanently: CCIP skipped the receiver call and reported
   success. Nothing can recover it. Remove that destination from the outbox
   allowlist so it cannot happen again.
2. If the receiver is correct, work the `MESSAGE_OVERDUE` steps — it is probably
   a FAILED message nobody executed.
3. If several messages are missing at once, **pause the outbox** before
   investigating. A repeating loss is worse than a stopped bridge.

### `LEDGER_GAP` — alarm

The desks disagree by more than in-flight messages explain.

1. `gatehouse reconcile --json` and read `unsettledMessages`.
2. Trace each one: `gatehouse trace <messageId>`.
3. The gap should equal the sum of the missing cargo. **If it does not, the
   accounting itself is wrong**, which is more serious than a lost message —
   pause both desks and reconcile by hand from event logs.

### `UNACCOUNTED_MINT` — alarm

Tokens were minted straight to the receiving desk, outside any recorded delivery.

**Pause immediately. This is the case the emergency stop exists for.**

Tokens existing on the destination with no matching burn on the source is what an
unbacked mint looks like from this side (T7).

1. Pause the inbox and the outbox.
2. Identify who holds mint authority on the destination token and whether that
   key is still trusted. **It is outside this system's control.**
3. Compare aggregate supply across both chains.
4. Do not unpause until the mint is explained. A legitimate explanation exists —
   a token administrator minting deliberately — but assume the worse one first.

### `UNACCOUNTED_BALANCE` — warn

The desk holds more than its books explain, and none of it was minted, so it
arrived as a plain transfer.

Usually innocent: someone sent tokens directly, or an operator pre-funded and
forgot. The contract's code never ran, so nothing was recorded.

1. Look at the token's `Transfer` events into the desk and find the one with no
   matching delivery.
2. If it was an operator, note it and move on.
3. If the sender is unknown, treat it as suspicious but not urgent — a donation
   cannot by itself take anything.

**Never treat a balance as proof of a delivery.** Anyone can change a balance
without the contract's permission.

### `RELEASE_DUE` — warn

Held cargo passed its release time and is still held.

- Legitimate transfer: call `releaseCargo(messageId)`. Anyone may do it.
- **Not legitimate: this is the window the delay exists to give you.** Pause
  first. A pause blocks release, so the funds stay frozen while you investigate.

### `INBOX_PAUSED` / `OUTBOX_PAUSED` — info

Someone paused it deliberately. Reported so an operator knows why deliveries
stopped; not a fault.

If nobody on the team paused it, treat the **guardian key as compromised**:
revoke it (`setGuardian`) and unpause from the owner. Worst case for a stolen
guardian key is denial of service ([ADR 0004](adr/0004-split-guardian-and-owner.md)).

---

## Incidents by shape

### The owner key is compromised

**The worst case in the system, and it is not mitigated** (T5).

An attacker with the owner key needs one call — `withdrawCargo(token, attacker,
everything)` — with no CCIP, no router, no fee. Speed matters more than accuracy.

1. From the **guardian** key, pause both desks immediately. Do not wait for the
   owner key; assume it is hostile.
2. Move any cargo you can still reach, from a key the attacker does not hold.
3. Assume both allowlists are now untrustworthy: the attacker can add themselves
   as a trusted sender and as a shipper.
4. Redeploy. Do not attempt to reclaim a compromised deployment.

The permanent fix is a multisig or timelock owner and split roles — recorded as
outstanding in [trust-assumptions.md](trust-assumptions.md#a7-the-owner-key-is-not-compromised).

### Reconciliation reports healthy but something is wrong

Trust the disagreement, not the tool. A monitor that under-reports looks exactly
like a healthy system (T9).

1. Check `fromBlock` for both chains in the deployment file. A start block set
   too high on the **source** chain hides shipped messages, which makes the
   ledgers appear to agree.
2. Check both RPC endpoints are answering and not silently truncating log ranges.
3. Compare `shippedCount` on the outbox against the number of messages the
   report lists. They should match.

### Messages started failing right after a deploy

Almost certainly destination gas (T10).

Adding gates to the inbox raises what execution costs, but `destinationGasLimit`
was purchased on the **source** chain before the receiver ran. The signature is
an empty `ReceiverError("0x")` — a revert with no reason.

1. `setDestinationGasLimit` to a higher value on the outbox.
2. Manually execute the stuck messages with more gas.
3. **Ordering rule for next time: raise the sender's limit before deploying a
   heavier receiver.**

---

## Post-incident

1. Write down what the first symptom was, and how long before anyone saw it.
2. If reconciliation did not catch it, **that is the finding** — the gap in
   detection matters more than the individual failure.
3. If a planned action paged someone, fix the severity. Alert fatigue is a
   security failure, not an annoyance.
4. Add a test. Every drill in this repository started as something that
   surprised someone.

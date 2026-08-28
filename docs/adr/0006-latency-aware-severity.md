# ADR 0006: Severity ramps with age, against a per-lane expectation

**Status:** accepted
**Date:** 2026-08-28

## Context

The first reconciler reported any shipped-but-not-received message as an alarm,
with severity decided only by whether it carried cargo.

On a real network that is wrong in the worst way. Delivery takes minutes,
dominated by source-chain finality — roughly 13–19 minutes out of Ethereum. So
**every message that has ever worked correctly spends time in that state.** The
alarm would fire constantly during healthy operation, and the alert channel would
stop meaning anything.

The information needed was already in the report. The findings logic read
`cargoAmount` and never looked at `shippedAtBlock`.

## Decision

Age each unsettled message against a configured per-lane expectation, and ramp:

```text
< expected latency        info    MESSAGES_IN_FLIGHT
> expected latency        warn    MESSAGE_OVERDUE
> 3x expected latency     alarm   MESSAGE_MISSING
```

`LEDGER_GAP` subtracts cargo explained by in-flight messages, so it reports a
real gap rather than latency.

"Now" is the later of the source chain's latest block timestamp and the wall
clock.

## Rationale

**A ramp, not a threshold**, because a binary cutoff only moves the
false-positive cliff. A ramp tells an operator how worried to be.

**Per-lane configuration, not a constant**, because finality differs by chain.
`expectedLatencySeconds` is deployment data, not code.

**The later of two clocks**, because each fails in a different direction. A chain
that stops producing blocks would otherwise report every pending message as
freshly sent, hiding exactly the outage worth alerting on. A host clock running
fast would report healthy messages as late.

Taking the maximum means **both** clocks must be behind for a late message to
look young. That errs toward alerting, which is correct for a tool whose job is
catching silent failures — and it is an honest trade, not a free win: it accepts
false positives from a skewed host in exchange for never hiding a stalled chain.

## Consequences

`MESSAGES_IN_FLIGHT` is `info` and keeps the system healthy. Normal operation
does not page anyone.

An expectation set too low produces noise; too high delays real detection.
Getting it somewhat wrong degrades gracefully rather than flipping, which is the
main reason for the ramp.

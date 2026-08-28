# ADR 0007: A token bucket, scoped to a lane

**Status:** accepted, replacing the fixed window from Checkpoint 5
**Date:** 2026-08-28

## Context

The Checkpoint 5 limiter used a fixed window with a hard reset:

```solidity
if (block.timestamp >= windowStartedAt[token] + configured.windowSeconds) {
    windowStartedAt[token] = block.timestamp;
    windowUsed[token] = 0;
}
```

That has a boundary, and a boundary can be burst across. With a budget of 2 per
hour:

```text
t = 1      spend 2   window used = 2
t = 3600   window resets, spend 2 again
```

**Four through in 3,599 seconds against an intended rate of two per hour.** The
defect is not that the cap is wrong; it is that the cap is enforced against a
window rather than against elapsed time, so the rate doubles across every
boundary. Chainlink's own rate limiter is a token bucket for this reason.

Separately, `limit` was keyed by token alone, so a busy lane consumed the budget
of a quiet one.

## Decision

A token bucket - burst capacity plus continuous refill - keyed by
`(lane, token)`, with an aggregate `ALL_LANES` bucket consumed alongside the
specific one.

```solidity
struct Limit { bool enabled; uint256 capacity; uint256 refillAmount; uint256 refillPeriod; }
```

**The rate is `refillAmount` per `refillPeriod`, not per second.** A per-second
rate stored as an integer rounds "5 per hour" down to zero, which would silently
disable every small limit.

**`lastRefillAt` advances only by the time the granted refill accounts for**, not
to `block.timestamp`:

```solidity
lastRefillAt += (refilled * config.refillPeriod) / config.refillAmount;
```

Resetting it to now would discard the remainder on every consume, so a desk used
frequently would never accrue anything - integer division would floor each small
interval to zero refill.

**Enabling a limit fills its bucket**, so turning a cap on does not block the
next action outright.

## Consequences

`refills continuously instead of resetting` is the regression test: exhaust the
budget, advance to just short of a full period, and only a partial refill is
available. Under the old code the entire budget would have returned one second
later.

Lane scoping mirrors the pair-keyed source allowlist from ADR 0002 for the same
reason: the pair is the identity. The aggregate bucket exists so a global cap can
bound total blast radius even when each individual lane looks reasonable.

An unconfigured limit is still unlimited, which is why disabling one counts as a
widening change - see [ADR 0008](0008-separated-powers-and-asymmetric-timelock.md).

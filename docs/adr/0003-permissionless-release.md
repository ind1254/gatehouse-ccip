# ADR 0003: Anyone may release held cargo, but not while paused

**Status:** accepted
**Date:** 2026-08-28

## Context

Cargo at or above `largeTransferThreshold` is held until `releaseDelay` elapses.
Someone has to end the hold. The obvious choice is `onlyOwner`.

## Decision

`releaseCargo` is callable by **anyone** once the delay has passed, and is
blocked entirely while the desk is paused.

## Rationale

**Permissionless**, because owner-only breaks the promise the delay makes:

- The owner could withhold settlement indefinitely.
- A lost owner key freezes held cargo permanently.
- Most importantly: a delay that requires permission to end is not a delay, it
  is a discretionary freeze. Permissionless release makes "held for one hour,
  then settled" a property of the system rather than a favour from the operator.

Releasing is the passage of time, not a privilege.

**Blocked while paused**, because otherwise the delay is a countdown an attacker
can rely on:

```text
10:00  attacker pushes a large transfer. Held, releasable at 11:00.
10:30  detected; guardian pauses
11:00  delay expires -> would settle mid-incident
```

A pause has to stop the *effect* of the clock, not merely new arrivals.

## Consequences

`withdrawCargo` subtracts held cargo from what is withdrawable, so the owner
cannot reach around the delay by moving the tokens it guards.

Pausing freezes in-flight value in place: not settled, not withdrawable, not
lost. That is invariant I6, and `freezes held cargo while the desk is paused`
asserts it.

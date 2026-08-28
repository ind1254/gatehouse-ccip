# ADR 0004: The guardian may pause but not unpause

**Status:** accepted
**Date:** 2026-08-28

## Context

An emergency stop is only useful if it can be reached quickly — realistically
from a phone, at night, by whoever is on call. That argues for a hot key.

Restarting a bridge is the opposite kind of decision. It declares an incident
understood and over.

Putting both on the same key forces a bad trade: keep it hot and a theft can
restart the bridge mid-incident, or keep it cold and nobody can stop an attack
in progress.

## Decision

Split them.

```solidity
function pause() external {            // guardian OR owner
function unpause() external onlyOwner; // owner only
```

## Consequences

The blast radius of each key is bounded by what it can do:

| Key stolen | Worst case |
|---|---|
| Guardian | Denial of service. Annoying, loud, recoverable. |
| Owner | Total loss. See T5. |

The guardian can be a hot key precisely because the worst it can do is stop
things. `does not let the guardian restart the bridge` asserts the asymmetry.

This does not fix the owner key being a single point of total failure — see
[trust-assumptions.md](../trust-assumptions.md#a7-the-owner-key-is-not-compromised).
It is one role split, not the full separation the system eventually needs.

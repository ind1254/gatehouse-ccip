# ADR 0008: Separated powers, and a delay that only applies to widening

**Status:** accepted, extending ADR 0004
**Date:** 2026-08-28

## Context

Checkpoint 5 split the guardian from the owner. That was one split, not
separation of powers: the owner could still both decide who is trusted and
withdraw everything. It was the top-ranked residual risk in the threat model,
and one call did it:

```solidity
inbox.withdrawCargo(token, attacker, everything);   // no CCIP, no fee, no delay
```

## Decision

### Three roles, and no owner bypass

| Role | May do | Key |
|---|---|---|
| `GUARDIAN_ROLE` | pause, cancel a scheduled widening | hot |
| `CONFIG_ROLE` | allowlists, limits, thresholds, gas limit, schedule | warm |
| `TREASURY_ROLE` | withdraw | cold |
| owner (`Ownable2Step`) | grant/revoke roles, unpause, set the delay | coldest |

**The owner has no implicit bypass.** To withdraw, the owner must grant itself
`TREASURY_ROLE` first - and granting a role is a widening change, so with a delay
configured that escalation is announced, visible, and cancellable. An owner that
could reach past the roles would make the separation decorative, which is why
there is a test named `gives the owner no implicit bypass of the treasury role`.

`Ownable2Step` means a handover needs the new owner to accept, so a mistyped
`transferOwnership` no longer bricks the contracts.

Roles are mappings, which cannot be enumerated on-chain, so every change emits
`RoleSet` and the tooling folds those events to find current holders.

### The delay applies to widening only

The rule ADR 0005 argued in prose is now enforced in code: **tightening is always
safe immediately; widening is not.**

| Call | Widening (delayed) | Tightening (immediate) |
|---|---|---|
| allowlists, roles | granting | revoking |
| `setLimit` | raising capacity, **or disabling** | lowering, or enabling |
| `setLargeTransferThreshold` | raising, or zeroing | lowering |
| `setReleaseDelay` | shortening | lengthening |
| `setTrustDelay` | shortening | lengthening |

Disabling a limit is widening because an unconfigured limit is unlimited.

The action id is `keccak256(abi.encode(address(this), msg.data))` - the calldata
itself. A schedule therefore authorises **exactly one call with exactly one set
of arguments**, not a category of call, and it is consumed on use so the same
widening cannot be replayed.

`trustDelay` defaults to zero so a fresh deployment is operable and the local
suite is unaffected. Raising it is tightening, so it takes effect immediately.

## Consequences

T5 changes shape. An attacker with the config key can no longer widen trust
instantly: they must schedule, wait, and survive a guardian who can cancel. It is
not eliminated - an attacker holding the owner key and enough patience still
wins, and a delay only helps if somebody is watching - but the runbook now has
something to act on, which it did not before.

The remaining gap is that all three roles start on the deployer.
`scripts/configure-testnet.ts` prints the exact calls to split them, in the right
order: **grant roles before raising the delay**, because granting is itself
widening.

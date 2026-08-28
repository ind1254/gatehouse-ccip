# ADR 0001: Cargo moves by transfer, not burn/mint

**Status:** accepted, with a known limitation
**Date:** 2026-08-28

## Context

CCIP's Cross-Chain Token standard supports four mechanisms: burn/mint,
lock/mint, lock/unlock, and burn/unlock. They differ in what each side does and
therefore in what invariant you can state:

| Model | Source | Destination | Aggregate supply |
|---|---|---|---|
| Burn / mint | Burn | Mint | **Constant** |
| Lock / mint | Lock | Mint wrapped | Grows |
| Lock / unlock | Lock | Release from reserve | Constant, needs liquidity |
| Burn / unlock | Burn | Release from reserve | Constant, needs a reserve |

Burn/mint is the right target for this project because it yields one testable
sentence: *across every chain, total supply never changes.* An unbacked mint is
counterfeiting, and every large bridge exploit is some version of it.

## Decision

Use CCIP's `tokenAmounts` with CCIP-BnM and defer real token pools.

Chainlink's `CCIPLocalSimulator` moves cargo with a direct `transferFrom` rather
than through token pools. So the local suite exercises **transfer semantics and
accounting**, not burn/mint.

## Consequences

`conserves the token supply across the transfer` asserts something true but
weak: supply is constant because nothing is minted or burned at all. It is
marked ⚠️ in [invariants.md](../invariants.md) rather than presented as a
burn/mint proof.

The gap is covered from the other direction instead: the reconciler detects a
mint into the inbox that no delivery explains (`UNACCOUNTED_MINT`). We cannot
prove supply is conserved locally, but we can detect the specific violation that
matters.

A real supply invariant needs token pools on live testnets. Recorded as
outstanding rather than quietly skipped.

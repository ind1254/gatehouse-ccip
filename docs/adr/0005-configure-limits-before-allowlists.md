# ADR 0005: Configure caps before permissions, always

**Status:** accepted
**Date:** 2026-08-28

## Context

Deployment configures each desk with rate limits, thresholds, allowlists, and
roles. The order looked arbitrary. It is not.

A limit that has never been configured is **unlimited**, not zero:

```solidity
Limit memory configured = limit[token];
if (!configured.enabled) return;   // no cap at all
```

`treats an unconfigured limit as no limit` documents this deliberately.

## Decision

In `scripts/configure-testnet.ts`, and in any future configuration, set limits
and thresholds **before** the allowlist entries that make shipping possible.

## Rationale

Reverse the order and there is a window — however brief — where a trusted sender
exists with no cap on it. Not a larger allowance: no cap at all. Everything the
desk holds is reachable in that window.

The two directions are not symmetric:

| Change | Safe to apply late? |
|---|---|
| Raising an existing limit | Yes — a cap was already in force |
| Adding a trusted sender | **No** — capability now exists uncapped |

## Consequences

This is an operational rule, not something the contracts enforce, so it lives in
the script with a comment and here. A contract-level fix — refusing to allowlist
a sender until a limit exists — is worth considering, and is not implemented.

The rule applies to every later change too, not just first deployment: adding a
lane, a token, or a shipper to a live system follows the same ordering.

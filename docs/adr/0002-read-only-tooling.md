# ADR 0002: Operator tooling is read-only, and proposes rather than sends

**Status:** accepted
**Date:** 2026-08-28

## Context

The CLI and the MCP server both need to reach live chain state. Both are natural
places to add `pause`, `unpause`, and `releaseCargo` — an operator console that
cannot act during an incident is arguably not a console.

Adding writes means the tool holds a signing key. For the MCP server it means
something further: a language model would be able to send transactions, while
sitting downstream of message notes that are attacker-authored text carried
across the bridge (T8).

Two specific failures:

1. A model that can `pause` denies service on a hallucination.
2. A model that can `unpause` ends an incident response early — exactly the
   attack the pause exists to stop.

## Decision

Neither tool holds a key or exposes anything that can send a transaction.

`gatehouse_prepare_pause` returns **unsigned calldata** plus a plain-English
description of the effect. A human reviews and submits it elsewhere.

```text
model ──► gatehouse_prepare_pause ──► { unsigned: true, to, data, effect }
                                            │
                                   human reviews and signs
```

## Consequences

Both tools are safe to run anywhere, by anyone, unattended — including in CI,
which is what makes `reconcile`'s exit codes useful.

Sanitising untrusted notes (I11) is a courtesy to a careful reader, not the
control. The control is that there is nothing to hijack.

An operator responding to an incident needs a separate signing path. That is
accepted: an emergency stop should require a human, and the runbook says so.

If write tools are ever added, T8 becomes the primary risk in the project and
this ADR must be revisited rather than quietly outgrown.

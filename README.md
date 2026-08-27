# Gatehouse

A security-first CCIP learning project, built one verified checkpoint at a time.

Everything runs on Hardhat's temporary local blockchain. No wallet, testnet
funds, or private key is needed yet.

```bash
npm install
npm test
npm run typecheck
```

## Checkpoint 1: a local warehouse inbox

[`WarehouseInbox.sol`](contracts/WarehouseInbox.sol) models only the destination
warehouse. It stores a text delivery, remembers the address that delivered it,
counts deliveries, and emits an event.

It does **not** use CCIP, and **anyone** can call `receiveDelivery`. That flaw is
kept on purpose: the test suite contains a test proving an attacker can forge a
delivery into it, which is the baseline the later checkpoints improve on.

## Checkpoint 2: a real CCIP message between two warehouses

| Contract | Role |
|---|---|
| [`WarehouseOutbox.sol`](contracts/WarehouseOutbox.sol) | Source shipping desk. Builds a CCIP message, quotes the fee, pays it in LINK, and calls `router.ccipSend`. |
| [`CcipWarehouseInbox.sol`](contracts/CcipWarehouseInbox.sol) | Destination receiving desk. Extends Chainlink's `CCIPReceiver`, so only the configured router can deliver. |
| [`test/LocalCcipHarness.sol`](contracts/test/LocalCcipHarness.sol) | Test-only wrapper around Chainlink's `CCIPLocalSimulator`, which plays both routers, the LINK token, and the courier network. |

Flow, all inside one local test blockchain:

```text
test wallet ──► WarehouseOutbox ──► mock CCIP router ──► CcipWarehouseInbox
                  ccipSend()                              _ccipReceive()
```

Three different "senders" appear in one delivery, and keeping them apart is most
of the security story:

| What | Who it is |
|---|---|
| The wallet that started it | the operator's wallet |
| `message.sender` | `WarehouseOutbox` |
| `msg.sender` inside `_ccipReceive` | the destination router |

What the [delivery tests](test/CcipDelivery.ts) prove:

- A message shipped from the outbox arrives at the inbox with CCIP's message ID.
- The inbox records the **source contract and source chain selector** that CCIP
  reports, not the wallet that paid.
- A direct `ccipReceive` call from an attacker reverts with `InvalidRouter`.
- The Checkpoint 1 inbox still accepts the same forged delivery.
- Shipping reverts with `NotEnoughFeeTokenBalance` when the desk cannot pay, and
  moves LINK to the router when it can.

The desk pays fees from its **own** LINK balance because the router collects with
`transferFrom(msg.sender)`, and `msg.sender` at the router is the outbox
contract. A contract cannot spend the operator's tokens.

## Checkpoint 3: authenticating the source, and refusing repeats

Checkpoint 2 proved a delivery arrived *through CCIP*. It never asked whether the
sender deserved to be trusted. Three gates now stand between a delivery and any
state change:

| Gate | Question it answers | Where |
|---|---|---|
| `onlyRouter` (inherited) | Did this arrive through CCIP at all? | `CCIPReceiver` |
| Source allowlist | Do we trust that contract, on that chain? | `allowedSourceWarehouse` |
| Processed ledger | Have we already acted on this messageId? | `processedMessages` |

The allowlist is keyed by the **(chain selector, address) pair**, not by two
independent lists:

```solidity
mapping(uint64 chainSelector => mapping(address warehouse => bool allowed))
    public allowedSourceWarehouse;
```

Two separate allowlists, one of chains and one of addresses, would accept a
trusted address arriving from the wrong chain. Addresses are not unique across
chains, so the pair is the real identity.

The shipping desk gained its own controls: `onlyShipper` on `shipDelivery`, and
an allowlist of (destination chain, receiving desk) pairs. Both desks use
OpenZeppelin `Ownable` for allowlist administration.

What the [authentication tests](test/SourceAuthentication.ts) prove:

- A **rogue outbox**, shipping through the genuine router to our inbox, is
  refused. That is the exact attack `onlyRouter` could not stop.
- A trusted warehouse arriving from an **unexpected chain** is refused.
- The owner can revoke a warehouse, and deliveries stop immediately.
- The same `messageId` is acted on **once**; a repeat reverts with
  `MessageAlreadyProcessed` and the delivery count does not move.
- A different `messageId` carrying identical text is still accepted. Replay
  protection keys on identity, not on content.
- Strangers cannot ship, shippers cannot aim at unapproved receivers, and
  non-owners cannot edit either allowlist.

### A testing technique worth noting

The mock router catches a receiver failure and re-throws its own
`ReceiverError(bytes)` with the original revert data nested inside, so a plain
end-to-end assertion can only say "it failed". Two ways around that, both used
here and both in [test-support/warehouses.ts](test-support/warehouses.ts):

1. **Impersonate the router** and call `ccipReceive` directly, which surfaces the
   inbox's own custom error.
2. **Encode the expected error** with viem and assert its bytes appear inside the
   wrapper.

## Checkpoint 4: moving actual tokens

`shipCargo` attaches an ERC-20 to the message. The token leaves the shipping
desk's own balance, travels in `tokenAmounts`, and CCIP credits it to the
receiving desk as part of executing the delivery.

```text
WarehouseOutbox ──┬─ text ──────────────┐
                  └─ tokens ────────────┴──► CcipWarehouseInbox
                     (Client.EVMTokenAmount[])
```

Both desks keep books: `totalShipped[token]` on the source side and
`totalReceived[token]` on the destination side. Those two numbers agreeing is the
invariant everything else is measured against, and Checkpoint 6 reconciles them.

A fourth guardrail joins the shipping desk: cargo must use an **allowlisted
token**, be non-zero, and be covered by the desk's own balance.

### The two tests that matter

**Tokens obey the gates.** In `moves no tokens when the inbox refuses the
delivery`, a rogue desk ships a funded, well-formed cargo message. The inbox
rejects the sender, the transaction reverts, and the token transfer is unwound
along with it. Balances on both sides are untouched. Nothing partial survives,
because a revert is all-or-nothing.

**Some failures are silent.** In `silently strands cargo sent to an address with
no contract code`, a delivery goes to an address with no contract on it. CCIP
skips the receiver call entirely:

```solidity
// MockRouter, matching real CCIP behaviour
if (... || receiver.code.length == 0 || !receiver.supportsInterface(...)) {
    return (true, "", 0);   // reported as SUCCESS
}
```

Nothing reverts. The tokens settle at the wrong address permanently, the inbox
never hears about it, and the source desk books the shipment as complete. The
only trace is `totalShipped` moving while `totalReceived` does not.

That is the argument for the destination allowlist in a single test: **it turns a
silent, permanent loss into a cheap revert on the source chain, before the fee is
ever paid.**

### Two honest limits of the local simulator

**It is not burn/mint.** Chainlink's `CCIPLocalSimulator` moves cargo with a
direct `transferFrom`, not through token pools. These tests therefore exercise
**transfer semantics and accounting**, not burn/mint. Aggregate supply is
asserted constant here because nothing is minted or burned at all, which is a
weaker claim than a real burn/mint invariant. Proving that one needs token pools
on live testnets, which is Checkpoint 7.

**It collapses two chains into one transaction, and that hides the most
important property of a real bridge.** In these tests, `ccipSend` and
`_ccipReceive` run inside a single call stack, so a revert in the inbox unwinds
the outbox too. Across real chains that is *not* what happens:

```text
local simulator          source tx ── inbox reverts ──► whole thing unwinds
real CCIP                source tx ✅ committed
                              ↓ (minutes later, separate transaction)
                         destination tx ❌ reverts, message left FAILED
```

On live networks the source transaction commits and is **never** rolled back by a
destination failure. The tokens have already left the source chain; the message
sits in a failed state until someone manually executes it. So `moves no tokens
when the inbox refuses the delivery` proves the destination transaction is
atomic - which is true and worth having - but it must not be read as proof that
the *bridge* is atomic. It is not. That gap between a committed source and a
failed destination is exactly the in-flight state Checkpoints 5 and 6 have to
handle.

## Checkpoint 5: limits that hold regardless of who is asking

Every defence so far authenticates a **caller**. All of them fail the same way:
compromise something already on the allowlist and the gates wave you through.
Checkpoint 5 adds controls that bound what *anyone* can do, including a
compromised but perfectly valid sender.

[`WarehouseControls.sol`](contracts/WarehouseControls.sol) holds the shared
machinery and both desks inherit it.

### A pause with a split key

```solidity
function pause() external {          // guardian OR owner
function unpause() external onlyOwner;   // owner only
```

Stopping is a reflex and belongs on a fast, hot key. Restarting declares the
emergency over and stays with the owner, which should be cold storage or a
multisig. That asymmetry is the point.

### A rolling-window rate limit

```solidity
struct Limit { bool enabled; uint256 amountPerWindow; uint256 windowSeconds; }
```

Limits are **opt-in via an explicit `enabled` flag** rather than inferred from a
zero amount, mirroring how Chainlink's own rate limiter is configured.

The zero address is a bucket for **delivery count**, not a token: every message
spends 1 from it. That is what bounds a flood of individually-valid messages -
fifty legitimate sends where replay protection has nothing to say, because fifty
distinct message IDs are not duplicates.

Both desks limit independently. The inbox limiting a sender it already trusts is
the whole idea: `bounds a compromised but still-allowlisted sender at the inbox`.

### A delay on large transfers

Cargo at or above `largeTransferThreshold` is **held** rather than settled:

```text
arrives ──► totalHeld  ──(releaseDelay elapses)──► totalReceived
                 │
                 └── not withdrawable, not counted
```

`releaseCargo` is callable by **anyone** - releasing is the passage of time, not
a privilege - but it is blocked while paused. And `withdrawCargo` subtracts held
cargo first, so the owner cannot reach around the delay by simply withdrawing the
tokens it guards.

That combination gives the invariant this checkpoint exists for: **a pause stops
new exposure without corrupting in-flight state.** `freezes held cargo while the
desk is paused` proves it - the delay expires during the incident, and the value
stays exactly where it was: not settled, not withdrawable, not lost.

### A bug worth keeping in the history

Adding these gates broke every cargo test with an empty `ReceiverError("0x")`.
The cause was gas: a heavier receiver no longer fit in the 200,000 gas the
message had bought. In production this fails **on arrival, after the fee is
paid**, and needs manual re-execution.

So `destinationGasLimit` is now a settable variable rather than a constant, with
a comment saying why. Every gate added to the inbox has to be paid for in the
source chain's gas budget, and that budget is set by the sender before the
receiver ever runs.

### Still missing on purpose

One owner key still controls both desks' allowlists, limits, thresholds, and
withdrawals. Splitting that into roles - and putting a timelock in front of the
dangerous ones - is the remaining structural weakness.

## Planned checkpoints

1. ~~Local destination inbox and state changes.~~ Done.
2. ~~Source contract, router, and a locally simulated CCIP message.~~ Done.
3. ~~Authentication of the source chain and sender; replay protection.~~ Done.
4. ~~Test-token transfer and balance accounting.~~ Done.
5. ~~Pausing, rate limits, and large-transfer delays.~~ Done.
6. Operator CLI, monitoring, reconciliation, and failure drills.

## Reference

- [Test CCIP locally](https://docs.chain.link/ccip/tutorials/evm/test-ccip-locally)
- [CCIP getting started](https://docs.chain.link/ccip/getting-started)

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
kept on purpose: `CcipDelivery.ts` contains a test proving an attacker can forge
a delivery into it, which is the baseline the next checkpoint improves on.

## Checkpoint 2: a real CCIP message between two warehouses

Three pieces now exist:

| Contract | Role |
|---|---|
| [`WarehouseOutbox.sol`](contracts/WarehouseOutbox.sol) | Source shipping desk. Builds a CCIP message, quotes the fee, pays it in LINK, and calls `router.ccipSend`. |
| [`CcipWarehouseInbox.sol`](contracts/CcipWarehouseInbox.sol) | Destination receiving desk. Extends Chainlink's `CCIPReceiver`, so only the configured router can deliver. |
| [`test/LocalCcipHarness.sol`](contracts/test/LocalCcipHarness.sol) | Test-only wrapper around Chainlink's `CCIPLocalSimulator`, which plays the part of both routers, the LINK token, and the courier network. |

Flow, all inside one local test blockchain:

```text
test wallet ──► WarehouseOutbox ──► mock CCIP router ──► CcipWarehouseInbox
                  ccipSend()                              _ccipReceive()
```

What the [tests](test/CcipDelivery.ts) prove:

- A message shipped from the outbox arrives at the inbox with CCIP's message ID.
- The inbox records the **source contract and source chain selector** that CCIP
  reports — not the wallet that paid, and not `msg.sender`.
- A direct `ccipReceive` call from an attacker reverts with `InvalidRouter`.
- The Checkpoint 1 inbox still accepts the same forged delivery.
- Shipping reverts with `NotEnoughFeeTokenBalance` when the desk cannot pay, and
  moves LINK to the router when it can.

### Still missing on purpose

The inbox trusts **any** source chain and **any** source warehouse, and it will
happily process the same message ID twice. The outbox lets anyone ship. Those
are the next checkpoints.

## Planned checkpoints

1. ~~Local destination inbox and state changes.~~ Done.
2. ~~Source contract, router, and a locally simulated CCIP message.~~ Done.
3. Authentication of the source chain and sender; replay protection.
4. Test-token transfer and balance accounting.
5. Pausing, rate limits, and large-transfer delays.
6. Operator CLI, monitoring, reconciliation, and failure drills.

## Reference

- [Test CCIP locally](https://docs.chain.link/ccip/tutorials/evm/test-ccip-locally)
- [CCIP getting started](https://docs.chain.link/ccip/getting-started)

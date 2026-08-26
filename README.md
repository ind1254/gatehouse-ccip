# Gatehouse

A security-first CCIP learning project, built one verified checkpoint at a time.

## Checkpoint 1: a local warehouse inbox

The first contract models only the destination warehouse. It can:

- receive and store a text delivery;
- remember the address that delivered it;
- count deliveries; and
- emit a `DeliveryReceived` event.

It does **not** use CCIP yet. It also intentionally allows any address to call
`receiveDelivery`. Both limitations become useful lessons in the next
checkpoints.

## Run it

```bash
npm install
npm test
```

Everything currently runs on Hardhat's temporary local blockchain. No wallet,
testnet funds, or private key is needed.

## Planned checkpoints

1. Local destination inbox and state changes.
2. Source contract, router, and a locally simulated CCIP message.
3. Authentication of the source chain and sender.
4. Test-token transfer and balance accounting.
5. Replay protection, pausing, and rate limits.
6. Operator CLI, monitoring, reconciliation, and failure drills.

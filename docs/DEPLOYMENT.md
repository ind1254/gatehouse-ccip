# Deploying Gatehouse to testnets

Ethereum Sepolia holds the shipping desk. Base Sepolia holds the receiving desk.
Everything here is testnet-only: the tokens have no value, and nothing in this
repository should ever be pointed at a network where they do.

## Before you start

**Use a fresh wallet that has never held anything of value.** Not your main
wallet, not one you use anywhere else. The key you deploy with becomes the owner
of both desks, which means it can move every token they hold. Treat it as
disposable and assume it will end up on this machine's disk.

You will need:

| What | Where |
|---|---|
| Sepolia ETH | [Chainlink faucet](https://faucets.chain.link/sepolia) or [Google Cloud faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia) |
| Base Sepolia ETH | [Base faucet](https://portal.cdp.coinbase.com/products/faucet) or bridge Sepolia ETH |
| Sepolia LINK | [Chainlink faucet](https://faucets.chain.link/sepolia) — pays CCIP fees |
| CCIP-BnM | `drip()` on the token contract, or the [CCIP test-token faucet](https://docs.chain.link/ccip/test-tokens) |
| Two RPC URLs | Alchemy, Infura, or any provider with a free tier |

## 1. Store the secrets

Secrets go in Hardhat's **encrypted keystore**, never in a file in this repo.
There is no `.env` in this project on purpose.

```bash
npx hardhat keystore set SEPOLIA_RPC_URL
npx hardhat keystore set BASE_SEPOLIA_RPC_URL
npx hardhat keystore set DEPLOYER_PRIVATE_KEY
```

Each prompts for the value and, the first time, for a password to encrypt the
store. `hardhat.config.ts` refers to these by name via `configVariable`, which
resolves lazily — so `npm test` never asks for the password.

Check what is stored, without printing values:

```bash
npx hardhat keystore list
```

## 2. Fill in the Base Sepolia test token

`src/networks.ts` has `testToken: undefined` for Base Sepolia, deliberately.
Look up CCIP-BnM for Base Sepolia in the
[CCIP directory](https://docs.chain.link/ccip/directory/testnet/chain/ethereum-testnet-sepolia-base-1)
and paste the address in, rather than trusting one someone remembered. Every
other address in that file was copied from the directory on 2026-08-28 with the
source recorded next to it.

Cargo shipments are disabled until this is set. Text-only deliveries work
without it.

## 3. Deploy both sides

```bash
npx hardhat run scripts/deploy-testnet.ts --network sepolia
npx hardhat run scripts/deploy-testnet.ts --network baseSepolia
```

Each writes its half of `deployments/testnet.json`, including the block it was
deployed in — which is where the reconciler starts scanning, so it never asks an
RPC provider for the entire history of the chain.

## 4. Introduce them to each other

```bash
npx hardhat run scripts/configure-testnet.ts --network sepolia
npx hardhat run scripts/configure-testnet.ts --network baseSepolia
```

Twice, because each side holds its own allowlist and neither chain can write to
the other's storage. Two chains means two transactions.

Note the ordering inside the script: **rate limits and thresholds are set before
the allowlist entries that make shipping possible**, so neither desk is ever
briefly live with no caps on it.

## 5. Fund the shipping desk

The desk pays CCIP fees from its **own** LINK balance, because the router
collects with `transferFrom(msg.sender)` and `msg.sender` at the router is the
outbox contract. A contract cannot spend your wallet's tokens.

Send LINK to the outbox address, and CCIP-BnM if you want to ship cargo.

## 6. Watch it

```bash
npm run gatehouse -- status \
  --deployment deployments/testnet.json \
  --rpc <sepolia-rpc> --dest-rpc <base-sepolia-rpc>

npm run gatehouse -- reconcile --deployment deployments/testnet.json ...
```

Two RPC endpoints now, because the desks are on different chains.

Immediately after shipping, expect `MESSAGES_IN_FLIGHT` and a healthy report.
A message is not late until it passes the lane's expected latency, which is
dominated by Ethereum finality at roughly 13–19 minutes. Watch it travel on the
[CCIP explorer](https://ccip.chain.link).

## What differs from local

| | Local simulator | Testnet |
|---|---|---|
| Delivery | Instant, same transaction | Minutes, dominated by finality |
| A destination revert | Unwinds the source too | Source already committed; message left FAILED |
| Token movement | Direct `transferFrom` | Real token pools |
| Failed messages | Impossible to observe | Manually executable from the CCIP explorer |

The second row is the one that matters. On testnet the source transaction
commits and is never rolled back by a destination failure, so "shipped but not
received" is a real state that has to be managed rather than an impossibility.

## If a message fails on arrival

It is not lost. Open it on the [CCIP explorer](https://ccip.chain.link), confirm
the state is `FAILED`, fix whatever caused it — unpause, raise a limit, restore
an allowlist entry, increase `destinationGasLimit` — and manually execute it.

The common causes, in the order worth checking:

1. The inbox is paused.
2. The rate-limit window is exhausted.
3. The source warehouse is not allowlisted on the destination.
4. `destinationGasLimit` is too small for the receiver as it stands now. Every
   gate added to the inbox costs destination gas, and that budget is purchased
   on the source chain before the receiver ever runs.

#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { reconcile, type BridgeClients, type Deployment, type Finding } from "../src/reconcile.js";
import { MESSAGE_COUNT_BUCKET, readStatus } from "../src/status.js";

/**
 * gatehouse - a read-only operator console.
 *
 * Read-only on purpose. Every write this system needs (pause, unpause, release,
 * allowlist changes) is a signed transaction, and signing needs a key-handling
 * design that belongs with the testnet deployment rather than bolted onto a
 * monitoring tool. Until then this cannot move anything, which means it is safe
 * to run anywhere, by anyone, including in CI.
 */

const USAGE = `
gatehouse - operator console for the Gatehouse CCIP bridge

Usage:
  gatehouse status      [--rpc <url>] [--dest-rpc <url>] [--deployment <file>]
  gatehouse reconcile   [--rpc <url>] [--deployment <file>] [--json]
  gatehouse trace <messageId>  [--rpc <url>] [--deployment <file>]

Options:
  --rpc         source-chain JSON-RPC      (default: http://127.0.0.1:8545)
  --dest-rpc    destination-chain JSON-RPC (default: same as --rpc)
  --deployment  deployment JSON to read (default: deployments/local.json)
  --json        machine-readable output

Exit codes:
  0  healthy
  1  something needs a human
  2  bad usage or unreachable node
`;

interface Args {
  command: string;
  positional: string[];
  rpc: string;
  destRpc: string;
  deployment: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let rpc = process.env.GATEHOUSE_RPC ?? "http://127.0.0.1:8545";
  let destRpc = process.env.GATEHOUSE_DEST_RPC ?? "";
  let deployment = process.env.GATEHOUSE_DEPLOYMENT ?? "deployments/local.json";
  let json = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rpc") rpc = argv[++i] ?? rpc;
    else if (arg === "--dest-rpc") destRpc = argv[++i] ?? destRpc;
    else if (arg === "--deployment") deployment = argv[++i] ?? deployment;
    else if (arg === "--json") json = true;
    else positional.push(arg);
  }

  return {
    command: positional[0] ?? "",
    positional: positional.slice(1),
    rpc,
    destRpc: destRpc || rpc,
    deployment,
    json,
  };
}

function loadDeployment(path: string): Deployment {
  try {
    const raw = readFileSync(resolve(path), "utf8");
    const parsed = JSON.parse(raw) as Partial<Deployment>;
    if (!parsed.outbox || !parsed.inbox) {
      throw new Error("deployment file must contain 'outbox' and 'inbox'");
    }
    return {
      outbox: parsed.outbox,
      inbox: parsed.inbox,
      tokens: parsed.tokens ?? [],
      expectedLatencySeconds: parsed.expectedLatencySeconds,
      fromBlock: parsed.fromBlock,
    };
  } catch (error) {
    console.error(`Could not read deployment file '${path}': ${String(error)}`);
    console.error("Run 'npm run deploy:local' against a running node first.");
    process.exit(2);
  }
}

const SEVERITY_MARK: Record<Finding["severity"], string> = {
  info: "  -",
  warn: "  !",
  alarm: " !!",
};

function formatLimit(
  enabled: boolean,
  amountPerWindow: bigint,
  windowSeconds: bigint,
  remaining: bigint,
): string {
  if (!enabled) return "unlimited";
  return `${remaining}/${amountPerWindow} left, window ${windowSeconds}s`;
}

function label(token: Address): string {
  return token.toLowerCase() === MESSAGE_COUNT_BUCKET
    ? "deliveries"
    : token;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command || args.command === "help" || args.command === "--help") {
    console.log(USAGE.trim());
    process.exit(args.command ? 0 : 2);
  }

  const deployment = loadDeployment(args.deployment);
  const clients: BridgeClients = {
    source: createPublicClient({ transport: http(args.rpc) }),
    destination: createPublicClient({ transport: http(args.destRpc) }),
  };

  try {
    await Promise.all([
      clients.source.getChainId(),
      clients.destination.getChainId(),
    ]);
  } catch {
    console.error(`Could not reach a node at ${args.rpc}.`);
    process.exit(2);
  }

  switch (args.command) {
    case "status": {
      const status = await readStatus(clients, deployment);
      if (args.json) {
        console.log(JSON.stringify(status, bigintReplacer, 2));
        break;
      }

      console.log("Shipping desk (source)");
      console.log(`  address            ${status.outbox.address}`);
      console.log(`  owner              ${status.outbox.owner}`);
      console.log(`  guardian           ${status.outbox.guardian}`);
      console.log(`  paused             ${status.outbox.paused ? "YES" : "no"}`);
      console.log(`  shipped            ${status.outbox.shippedCount}`);
      console.log(`  destination gas    ${status.outbox.destinationGasLimit}`);
      for (const limit of status.outbox.limits) {
        console.log(
          `  limit ${label(limit.token).padEnd(12)} ${formatLimit(limit.enabled, limit.amountPerWindow, limit.windowSeconds, limit.remaining)}`,
        );
      }

      console.log("\nReceiving desk (destination)");
      console.log(`  address            ${status.inbox.address}`);
      console.log(`  owner              ${status.inbox.owner}`);
      console.log(`  guardian           ${status.inbox.guardian}`);
      console.log(`  paused             ${status.inbox.paused ? "YES" : "no"}`);
      console.log(`  delivered          ${status.inbox.deliveryCount}`);
      console.log(`  release delay      ${status.inbox.releaseDelay}s`);
      for (const limit of status.inbox.limits) {
        console.log(
          `  limit ${label(limit.token).padEnd(12)} ${formatLimit(limit.enabled, limit.amountPerWindow, limit.windowSeconds, limit.remaining)}`,
        );
      }
      break;
    }

    case "reconcile": {
      const report = await reconcile(clients, deployment);
      if (args.json) {
        console.log(JSON.stringify(report, bigintReplacer, 2));
        process.exit(report.healthy ? 0 : 1);
      }

      console.log(`Reconciliation at ${new Date(report.checkedAt * 1000).toISOString()}`);
      console.log(
        `  messages shipped   ${report.messages.length}` +
          `  settled ${report.messages.filter((m) => m.received).length}` +
          `  in flight ${report.inFlightMessages.length}` +
          `  late ${report.unsettledMessages.length}`,
      );
      console.log(`  expected latency   ${report.expectedLatencySeconds}s`);

      for (const ledger of report.ledgers) {
        console.log(`\n  token ${ledger.symbol ?? ledger.destinationToken}`);
        console.log(`    shipped        ${ledger.shipped}`);
        console.log(`    received       ${ledger.received}`);
        console.log(`    held           ${ledger.held}`);
        console.log(`    inbox balance  ${ledger.inboxBalance}`);
        console.log(`    in flight      ${ledger.inFlight}`);
        console.log(`    missing        ${ledger.missing}`);
        console.log(`    unaccounted    ${ledger.unaccounted}`);
        if (ledger.unaccountedFromMint > 0n) {
          console.log(`    of which MINTED ${ledger.unaccountedFromMint}`);
        }
      }

      if (report.findings.length === 0) {
        console.log("\nNo findings. Books agree.");
      } else {
        console.log("");
        for (const finding of report.findings) {
          console.log(`${SEVERITY_MARK[finding.severity]} [${finding.code}] ${finding.message}`);
        }
      }

      console.log(`\n${report.healthy ? "HEALTHY" : "NEEDS ATTENTION"}`);
      process.exit(report.healthy ? 0 : 1);
    }

    case "trace": {
      const messageId = args.positional[0] as Hex | undefined;
      if (!messageId) {
        console.error("trace needs a messageId");
        process.exit(2);
      }

      const report = await reconcile(clients, deployment);
      const message = report.messages.find(
        (candidate) => candidate.messageId.toLowerCase() === messageId.toLowerCase(),
      );

      if (!message) {
        console.log(`${messageId} was never shipped from this desk.`);
        process.exit(1);
      }

      console.log(`message   ${message.messageId}`);
      console.log(`shipped   block ${message.shippedAtBlock}`);
      console.log(`receiver  ${message.receiver}`);
      console.log(`note      ${message.note}`);
      if (message.cargoAmount) {
        console.log(`cargo     ${message.cargoAmount} of ${message.cargoToken}`);
      }
      console.log(`received  ${message.received ? "yes" : "NO"}`);

      const held = report.held.find(
        (candidate) => candidate.messageId.toLowerCase() === messageId.toLowerCase(),
      );
      if (held) {
        console.log(
          `held      ${held.amount}, releasable at ${held.releasableAt}` +
            `${held.released ? " (released)" : held.due ? " (DUE NOW)" : " (waiting)"}`,
        );
      }

      process.exit(message.received ? 0 : 1);
    }

    default:
      console.error(`Unknown command '${args.command}'.\n`);
      console.log(USAGE.trim());
      process.exit(2);
  }
}

function bigintReplacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});

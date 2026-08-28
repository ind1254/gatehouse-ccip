#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { reconcile, type Deployment, type Finding } from "../src/reconcile.js";
import { readStatus } from "../src/status.js";
import { fenceUntrusted, UNTRUSTED_DATA_NOTICE } from "../src/untrusted.js";
import { FINDING_GUIDE } from "../src/findings-guide.js";

/**
 * An MCP server over the Gatehouse operator console.
 *
 * READ-ONLY, deliberately and structurally. There is no signer here, no private
 * key, and no tool that can send a transaction. The reason is the whole point of
 * the exercise:
 *
 *   1. A model that can pause the bridge can deny service on a hallucination.
 *   2. A model that can unpause can end an incident response early - which is
 *      exactly the attack the pause exists to stop.
 *   3. Message notes are attacker-chosen text that crossed a chain to get here.
 *      Anything that reads them is downstream of an untrusted input.
 *
 * `gatehouse_prepare_pause` shows the shape writes should take when they arrive:
 * the server describes a transaction and returns its calldata, and a human signs
 * it somewhere else. Proposing is not the same as sending.
 */

const RPC_URL = process.env.GATEHOUSE_RPC ?? "http://127.0.0.1:8545";
const DEPLOYMENT_PATH =
  process.env.GATEHOUSE_DEPLOYMENT ?? "deployments/local.json";

/// pause() - the 4-byte selector of keccak256("pause()").
const PAUSE_SELECTOR = "0x8456cb59";

function loadDeployment(): Deployment {
  const raw = readFileSync(resolve(DEPLOYMENT_PATH), "utf8");
  const parsed = JSON.parse(raw) as Partial<Deployment>;
  if (!parsed.outbox || !parsed.inbox) {
    throw new Error(
      `${DEPLOYMENT_PATH} must contain 'outbox' and 'inbox' addresses`,
    );
  }
  return {
    outbox: parsed.outbox,
    inbox: parsed.inbox,
    tokens: parsed.tokens ?? [],
  };
}

function client(): PublicClient {
  return createPublicClient({ transport: http(RPC_URL) });
}

function json(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          value,
          (_key, item) => (typeof item === "bigint" ? item.toString() : item),
          2,
        ),
      },
    ],
  };
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text:
          `Could not reach the Gatehouse deployment.\n` +
          `rpc: ${RPC_URL}\ndeployment: ${DEPLOYMENT_PATH}\n\n${String(error)}`,
      },
    ],
  };
}

const server = new McpServer({ name: "gatehouse", version: "0.1.0" });

server.registerTool(
  "gatehouse_status",
  {
    title: "Gatehouse status",
    description:
      "Read both desks of the Gatehouse CCIP bridge: owner, guardian, whether " +
      "each side is paused, configured rate limits and how much of each window " +
      "budget remains, the destination gas limit, and the release delay. " +
      "Read-only.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      return json(await readStatus(client(), loadDeployment()));
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "gatehouse_reconcile",
  {
    title: "Reconcile the bridge ledgers",
    description:
      "Compare what the source desk says it shipped against what the " +
      "destination desk says it received, and report findings. This is how " +
      "silent failures are detected: cargo delivered to an address with no " +
      "contract code is reported by CCIP as a success, so it can only be found " +
      "by comparing ledgers. Read-only. " +
      UNTRUSTED_DATA_NOTICE,
    inputSchema: {
      severity: z
        .enum(["all", "actionable"])
        .default("actionable")
        .describe(
          "'actionable' hides informational findings such as a deliberate pause.",
        ),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ severity }) => {
    try {
      const report = await reconcile(client(), loadDeployment());

      const findings =
        severity === "all"
          ? report.findings
          : report.findings.filter((finding) => finding.severity !== "info");

      return json({
        healthy: report.healthy,
        checkedAt: report.checkedAt,
        outboxPaused: report.outboxPaused,
        inboxPaused: report.inboxPaused,
        findings,
        ledgers: report.ledgers,
        held: report.held,
        messageCount: report.messages.length,
        unsettledCount: report.unsettledMessages.length,
        // Notes are fenced and never returned raw.
        unsettledMessages: report.unsettledMessages.map((message) => ({
          messageId: message.messageId,
          receiver: message.receiver,
          cargoToken: message.cargoToken,
          cargoAmount: message.cargoAmount,
          note: fenceUntrusted(message.note),
        })),
        securityNotice: UNTRUSTED_DATA_NOTICE,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "gatehouse_trace",
  {
    title: "Trace one cross-chain message",
    description:
      "Follow a single messageId from the shipping desk to the receiving desk " +
      "and report whether it settled, is held, or was never recorded. " +
      "Read-only. " +
      UNTRUSTED_DATA_NOTICE,
    inputSchema: {
      messageId: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/, "messageId must be a 32-byte hex string")
        .describe("The CCIP message ID, as returned by ccipSend."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ messageId }) => {
    try {
      const report = await reconcile(client(), loadDeployment());
      const wanted = messageId.toLowerCase();

      const message = report.messages.find(
        (candidate) => candidate.messageId.toLowerCase() === wanted,
      );
      if (!message) {
        return json({
          messageId,
          found: false,
          explanation:
            "This messageId was never shipped from the configured outbox. It " +
            "may belong to a different deployment.",
        });
      }

      const held = report.held.find(
        (candidate) => candidate.messageId.toLowerCase() === wanted,
      );

      return json({
        messageId: message.messageId,
        found: true,
        shippedAtBlock: message.shippedAtBlock,
        receiver: message.receiver,
        cargoToken: message.cargoToken,
        cargoAmount: message.cargoAmount,
        received: message.received,
        held: held ?? null,
        note: fenceUntrusted(message.note),
        securityNotice: UNTRUSTED_DATA_NOTICE,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

server.registerTool(
  "gatehouse_explain_finding",
  {
    title: "Explain a reconciliation finding",
    description:
      "Explain what a Gatehouse finding code means, what usually causes it, " +
      "and what an operator should check. Static reference text; touches no " +
      "network.",
    inputSchema: {
      code: z
        .string()
        .describe("A finding code, for example UNSETTLED_MESSAGE."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ code }) => {
    const entry = FINDING_GUIDE[code.toUpperCase()];
    if (!entry) {
      return json({
        code,
        known: false,
        knownCodes: Object.keys(FINDING_GUIDE),
      });
    }
    return json({ code: code.toUpperCase(), known: true, ...entry });
  },
);

server.registerTool(
  "gatehouse_prepare_pause",
  {
    title: "Prepare an unsigned pause transaction",
    description:
      "Describe the transaction that would pause a Gatehouse desk and return " +
      "its calldata. This DOES NOT send anything: this server holds no key and " +
      "cannot sign. A human must review and submit it. Pausing stops new " +
      "shipments and causes arriving deliveries to revert; those messages are " +
      "not lost and can be re-executed after unpausing.",
    inputSchema: {
      desk: z.enum(["outbox", "inbox"]).describe("Which desk to pause."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ desk }) => {
    try {
      const deployment = loadDeployment();
      const target: Address =
        desk === "outbox" ? deployment.outbox : deployment.inbox;

      return json({
        unsigned: true,
        to: target,
        data: PAUSE_SELECTOR,
        value: "0",
        functionSignature: "pause()",
        desk,
        effect:
          desk === "outbox"
            ? "No new shipments can leave. In-flight messages are unaffected."
            : "Arriving deliveries revert and must be re-executed after " +
              "unpausing. Held cargo stops maturing: releaseCargo is blocked " +
              "while paused.",
        callableBy: "the guardian or the owner",
        nextStep:
          "Review this, then submit it from the guardian key. This server " +
          "cannot sign or send it.",
      });
    } catch (error) {
      return failure(error);
    }
  },
);

await server.connect(new StdioServerTransport());

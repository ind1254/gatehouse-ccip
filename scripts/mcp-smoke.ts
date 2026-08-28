import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Smoke test for the MCP server: start it, list its tools, and call the two
 * that matter. Proves the wiring works and that message notes come back fenced.
 */

const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "mcp/server.ts"],
  env: { ...process.env } as Record<string, string>,
});

const client = new Client({ name: "gatehouse-smoke", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:");
for (const tool of tools) {
  const readOnly = tool.annotations?.readOnlyHint ? "read-only" : "WRITE";
  console.log(`  ${tool.name.padEnd(28)} ${readOnly}`);
}

const reconcileResult = await client.callTool({
  name: "gatehouse_reconcile",
  arguments: { severity: "actionable" },
});
const text = (reconcileResult.content as Array<{ text: string }>)[0].text;
const report = JSON.parse(text);

console.log("\ngatehouse_reconcile:");
console.log(`  healthy        ${report.healthy}`);
console.log(`  findings       ${report.findings.map((f: any) => f.code).join(", ") || "none"}`);
for (const message of report.unsettledMessages ?? []) {
  console.log(`  unsettled note ${message.note}`);
}

const explain = await client.callTool({
  name: "gatehouse_explain_finding",
  arguments: { code: "unsettled_message" },
});
const guide = JSON.parse((explain.content as Array<{ text: string }>)[0].text);
console.log(`\ngatehouse_explain_finding: known=${guide.known} severity=${guide.severity}`);

const prepared = await client.callTool({
  name: "gatehouse_prepare_pause",
  arguments: { desk: "inbox" },
});
const tx = JSON.parse((prepared.content as Array<{ text: string }>)[0].text);
console.log(`gatehouse_prepare_pause: unsigned=${tx.unsigned} to=${tx.to} data=${tx.data}`);

await client.close();

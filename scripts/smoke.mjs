// Smoke test: arranca el servidor por stdio y valida el handshake MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "pipe",
});

transport.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

const client = new Client({ name: "smoke", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`OK: ${tools.length} herramientas`);
for (const t of tools) {
  console.log(` - ${t.name}: ${t.description?.slice(0, 70)}`);
}

const status = await client.callTool({ name: "slots_status", arguments: {} });
console.log("\nslots_status ->", status.content?.[0]?.text?.slice(0, 400));

await client.close();
process.exit(0);

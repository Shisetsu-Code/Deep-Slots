import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "pipe" });
const client = new Client({ name: "rtp", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  return res.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

await call("slots_open", { url: "http://127.0.0.1:8787/" });
console.log(await call("slots_run_session", { spins: 40, delayMs: 0, settleMs: 250 }));
await call("slots_close");
await client.close();
process.exit(0);

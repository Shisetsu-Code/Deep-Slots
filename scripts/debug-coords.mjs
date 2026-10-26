import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testCfg = path.join(root, ".slots-artifacts", "debug-config.json");
fs.copyFileSync(path.join(root, "slots.config.json"), testCfg);
const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] != null));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "pipe",
  env: { ...env, SLOTS_CONFIG: testCfg },
});
const client = new Client({ name: "dbg", version: "0" }, { capabilities: {} });
await client.connect(transport);

const call = async (name, args = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const t = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  console.log(`\n### ${name}\n${t.slice(0, 900)}`);
  return t;
};

await call("slots_config", { patch: JSON.stringify({ selectors: { spin: "#spin", balance: "#balance", bet: "#bet" }, network: { spinEndpoint: "/api/spin" }, browser: { headless: true } }) });
await call("slots_open", { url: "http://127.0.0.1:8787/" });
const map = await call("slots_map");
console.log("\nSPIN ENTRY:", map.slice(map.indexOf('"id": "spin"') - 220, map.indexOf('"id": "spin"') + 80));

// esperar a que el layout este estable
await call("slots_wait", { ms: 1000 });
await call("slots_click_id", { id: "spin" });
await call("slots_wait", { ms: 1500 });
await call("slots_state");
await call("slots_network", { limit: 20 });

// comparar con click por selector
await call("slots_click", { selector: "#spin" });
await call("slots_wait", { ms: 1500 });
await call("slots_state");

await call("slots_close");
await client.close();
process.exit(0);

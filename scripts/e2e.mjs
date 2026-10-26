// Test end-to-end del MCP contra el fixture local.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testCfg = path.join(root, ".slots-artifacts", "test-config.json");
fs.mkdirSync(path.dirname(testCfg), { recursive: true });
fs.copyFileSync(path.join(root, "slots.config.json"), testCfg);

const calls = [];
const env = Object.fromEntries(
  Object.entries(process.env).filter((e) => e[1] != null),
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "pipe",
  env: { ...env, SLOTS_CONFIG: testCfg },
});
const client = new Client({ name: "e2e", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c) => c.text ?? `<${c.type}>`).join("\n") ?? "";
  calls.push({ name, text });
  console.log(`\n=== ${name} ===\n${text.slice(0, 1200)}`);
  return text;
}

// Calibrar config contra el fixture
await call("slots_config", {
  patch: JSON.stringify({
    selectors: {
      spin: "#spin",
      betIncrease: "#bet-up",
      betDecrease: "#bet-down",
      balance: "#balance",
      bet: "#bet",
      win: "#win",
      canvas: "#game",
    },
    network: { spinEndpoint: "/api/spin" },
    spin: { settleMs: 300, timeoutMs: 8000 },
    browser: { headless: true },
  }),
});

await call("slots_open", { url: "http://127.0.0.1:8787/" });

const discover = await call("slots_discover");
if (!discover.includes("#spin")) console.log("AVISO: discover no vio el boton de giro");

await call("slots_state");
await call("slots_set_bet", { amount: 2 });
await call("slots_spin");
await call("slots_run_session", { spins: 8, delayMs: 50 });
await call("slots_network", { urlPattern: "/api/spin", includeBodies: true, bodyLimit: 2 });
await call("slots_console", { limit: 3 });
await call("slots_screenshot", { selector: "#game" });
await call("slots_close");

await client.close();
process.exit(0);

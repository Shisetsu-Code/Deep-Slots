// Valida el flujo por coordenadas: map -> click_id -> autoConfirm -> botones recortados.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testCfg = path.join(root, ".slots-artifacts", "test-config.json");
fs.mkdirSync(path.dirname(testCfg), { recursive: true });
fs.copyFileSync(path.join(root, "slots.config.json"), testCfg);

const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] != null));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "pipe",
  env: { ...env, SLOTS_CONFIG: testCfg },
});
const client = new Client({ name: "coords", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const images = (res.content ?? []).filter((c) => c.type === "image");
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  if (images.length) fs.writeFileSync(path.join(root, ".slots-artifacts", `${name}-preview.png`), Buffer.from(images[0].data, "base64"));
  console.log(`\n=== ${name} ===${images.length ? ` [imagen ${images[0].data.length} b64]` : ""}\n${text.slice(0, 1500)}`);
  return { res, text };
}

await call("slots_config", {
  patch: JSON.stringify({
    selectors: {
      spin: "#spin", betIncrease: "#bet-up", betDecrease: "#bet-down",
      balance: "#balance", bet: "#bet", win: "#win", canvas: "#game",
    },
    network: { spinEndpoint: "/api/spin" },
    spin: { settleMs: 300, timeoutMs: 8000 },
    browser: { headless: true },
  }),
});

await call("slots_open", { url: "http://127.0.0.1:8787/" });

const { text: mapText } = await call("slots_map");
const ids = [...mapText.matchAll(/"id": "([^"]+)"/g)].map((m) => m[1]);
console.log("\nIDs del mapa:", ids.join(", "));

// Navegar SOLO con coordenadas guardadas
await call("slots_click_id", { id: "bet-up" });
await call("slots_state");
await call("slots_click_id", { id: "spin", waitForNetwork: "/api/spin", settleMs: 600 });
await call("slots_state");

// Compra de bonus con confirmacion (el caso tedioso)
await call("slots_click_id", { id: "buy-bonus", autoConfirm: true, confirmTimeoutMs: 3000 });
await call("slots_wait", { ms: 1200 });
await call("slots_state");
await call("slots_network", { urlPattern: "/api/", includeBodies: true });
await call("slots_console", { limit: 6 });

// Recortes de botones usables
await call("slots_buttons", {});

// Reutilizar coordenadas sin volver a capturar
await call("slots_coords");

await call("slots_close");
await client.close();
process.exit(0);

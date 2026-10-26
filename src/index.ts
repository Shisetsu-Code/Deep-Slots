#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Session } from "./session.js";
import { registerTools } from "./tools.js";
import { registerElkTools } from "./tools-elk.js";
import { registerHarTools } from "./tools-har.js";
import { ElkRegistry } from "./elk/registry.js";
import { configPath, loadConfig } from "./config.js";

const pkgVersion = "0.2.0";

const server = new McpServer(
  { name: "deep-slots", version: pkgVersion },
  {
    instructions: [
      "Servidor de QA para slots de casino en modo demo (dinero ficticio).",
      "Tres vias, en este orden de costo:",
      "1) Protocolo (mas barato y autoritativo): elk_init -> elk_bets -> elk_spin/elk_run. Elk usa XML sobre HTTP POST a /capi/{gameId}/play/{op}; bmode=DEF es el giro normal y X01..X05 son feature buys. Cada purchase devuelve un replay determinista (clientseed + revision + RESULTS/ACTIONS).",
      "2) HAR (sin red): har_summary -> har_api -> har_import_elk para derivar la ficha de adaptador de un proveedor desde capturas.",
      "3) Navegador (solo cuando no hay transporte directo): slots_open -> slots_probe (canvas Cocos) o slots_discover/slots_map (DOM) -> slots_click_id -> slots_state -> slots_spin.",
      "Elk tiene DOM real (ids #landscape-*/#portrait-*), asi que nunca hace falta vision. Para canvas Cocos usa slots_canvas_map y coords.json por huella de layout.",
      "slots_network con includeBodies=true, bodySide='both' y raw=true devuelve cuerpos binarios exactos en base64/hex; slots_network_export los vuelca a JSON.",
      "Usa slots_console y slots_network para diagnosticar errores.",
      "Importante: no altera el RNG ni las respuestas del servidor; solo observa y automatiza como un jugador. Nunca resuelve captchas.",
    ].join(" "),
  },
);

const session = new Session();
const elk = new ElkRegistry();
registerTools(server, session);
registerElkTools(server, elk);
registerHarTools(server);

const transport = new StdioServerTransport();

async function shutdown(): Promise<void> {
  await session.close().catch(() => undefined);
  await server.close().catch(() => undefined);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("unhandledRejection", (reason) => {
  console.error("[deep-slots] unhandledRejection:", reason);
});

await server.connect(transport);

const cfg = loadConfig();
console.error(
  `[deep-slots] listo. config=${configPath} url=${cfg.url || "(sin definir)"} ` +
    `spin=${cfg.selectors.spin ?? "(auto)"} endpoint=${cfg.network.spinEndpoint ?? "(sin definir)"} ` +
    `elk=${cfg.elk.origin}${cfg.elk.gameId ? ` gameId=${cfg.elk.gameId}` : ""}`,
);

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import { loadConfig, writeConfigPatch, configPath } from "./config.js";
import type { Session } from "./session.js";
import { artifactPath, mean, percentile, stdev, truncate } from "./util.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const show = (label: string, value: unknown): ToolResult =>
  ok(`${label}\n${JSON.stringify(value, null, 2)}`);
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

function round(n: number | null, d = 2): number | null {
  return n == null ? null : Number(n.toFixed(d));
}

export function registerTools(server: McpServer, session: Session): void {
  // ---------------------------------------------------------------- estado
  server.registerTool(
    "slots_map",
    {
      title: "Mapa de coordenadas (captura + IDs)",
      description:
        "Hace UNA captura con cajas numeradas sobre cada boton/elemento usable y guarda sus coordenadas con IDs estables (spin, bet-up, buy-bonus...). Despues navega con slots_click_id sin volver a capturar ni buscar selectores. Usalo solo cuando no sepas donde estas o cambie la UI.",
      inputSchema: {
        overlay: z.boolean().optional().describe("Dibujar cajas numeradas (default true)"),
        save: z.boolean().optional().describe("Guardar PNG y coords.json (default true)"),
      },
    },
    async ({ overlay, save }) => {
      try {
        const map = await session.captureMap({ overlay, save });
        return {
          content: [
            { type: "image", data: map.base64, mimeType: "image/png" },
            {
              type: "text",
              text: `Mapa guardado (${map.entries.length} elementos). El numero del overlay corresponde a "n".\n` +
                `Usa slots_click_id con "id" (o "n"). Coordenadas: ${map.coordsFile ?? "(no guardadas)"}\n` +
                JSON.stringify(map.entries, null, 2),
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_coords",
    {
      title: "Ver coordenadas guardadas",
      description: "Lista el mapa de coordenadas activo (IDs, etiquetas, posiciones) sin hacer captura.",
      inputSchema: {},
    },
    async () => {
      try {
        const cache = session.loadCoords();
        if (!cache) return ok("No hay coordenadas guardadas. Usa slots_map.");
        return show(`Coordenadas de ${cache.url} (guardadas ${cache.savedAt})`, cache.entries);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_buttons",
    {
      title: "Recortes de botones utilizables",
      description:
        "Devuelve un montaje solo con los botones usables (recortados a su caja), en el orden de la lista. Sirve para reconocer iconos sin DOM: apuestas, turbo, autoplay, comprar bonus. Usa las coordenadas guardadas; si no hay, las calcula.",
      inputSchema: {
        ids: z.array(z.string()).optional().describe("IDs concretos a recortar (por defecto todos)"),
        max: z.number().int().min(1).max(24).optional(),
      },
    },
    async ({ ids, max }) => {
      try {
        const res = await session.buttonsMontage({ ids, max });
        return {
          content: [
            { type: "image", data: res.base64, mimeType: "image/png" },
            {
              type: "text",
              text:
                `Recortes en orden (izq→der, arriba→abajo): ${res.items.map((i) => i.id).join(", ")}\n` +
                (res.path ? `Guardado en: ${res.path}\n` : "") +
                JSON.stringify(res.items, null, 2),
            },
          ],
        };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_canvas_map",
    {
      title: "Mapa del motor (Cocos) → IDs clickeables",
      description:
        "Lee el arbol de la escena del motor (Cocos Creator 2.x) y traduce cada boton a coordenadas de viewport con IDs canonicos (spin, bet-up, bet-options, turbo, autoplay, wallet...). Por defecto solo devuelve lo realmente clickeable (cc.Button / *Button / SpinButtonView) que se dibuja; includeAll=true anade el resto del arbol. Guarda coords.json para navegar luego con slots_click_id. Para juegos 100% canvas es el equivalente a slots_map, pero sin depender del DOM (que no existe).",
      inputSchema: {
        minSize: z.number().int().min(4).max(400).optional().describe("Tamano minimo en px de viewport (default 18)"),
        includeAll: z.boolean().optional().describe("Incluir nodos con nombre no-boton (arbol completo, ruidoso)"),
        screenshot: z.boolean().optional().describe("Adjuntar captura con cajas numeradas"),
        save: z.boolean().optional().describe("Guardar coords.json (default true)"),
        maxNodes: z.number().int().min(100).max(200000).optional(),
      },
    },
    async ({ minSize, includeAll, screenshot, save, maxNodes }) => {
      try {
        const map = await session.canvasMap({ minSize, includeAll, screenshot, save, maxNodes });
        const summary = {
          engine: map.engine,
          calibration: map.calibration,
          sceneNodes: map.sceneNodes,
          usables: map.entries.length,
          descartados: map.skipped,
          coordsFile: map.coordsFile,
          warning: map.warning,
          ids: map.entries.map((e) => ({ n: e.n, id: e.id, label: e.label, x: e.x, y: e.y, w: e.w, h: e.h, path: e.path })),
        };
        const content: ToolResult["content"] = [];
        if (map.base64) content.push({ type: "image", data: map.base64, mimeType: "image/png" });
        content.push({
          type: "text",
          text:
            `Mapa del motor: ${map.entries.length} elementos usables de ${map.sceneNodes} nodos.\n` +
            (map.coordsFile ? `Coordenadas guardadas: ${map.coordsFile}\n` : "") +
            (map.warning ? `Aviso: ${map.warning}\n` : "") +
            `Navega con slots_click_id. Detalle:\n` +
            JSON.stringify(summary, null, 2),
        });
        return { content };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_probe",
    {
      title: "Estado interno del motor",
      description:
        "Lee el modelo del juego (no la animacion): saldo, saldo objetivo, premio y apuesta desde los componentes del motor (Cocos). Tambien lista nodos y etiquetas utiles. Es la fuente fiable para calcular saldo_final = saldo_inicial - apuesta + premio en juegos canvas.",
      inputSchema: {
        treeDepth: z.number().int().min(0).max(6).optional().describe("Profundidad del arbol a listar (default 2)"),
        pattern: z.string().optional().describe("Regex de propiedades a leer (default balance|win|bet|credit|cash...)"),
        maxFields: z.number().int().min(1).max(40).optional(),
      },
    },
    async ({ treeDepth, pattern, maxFields }) => {
      try {
        return show("Estado del motor", await session.probeEngine({ treeDepth, pattern, maxFields }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_click_id",
    {
      title: "Click por ID de coordenada",
      description:
        "Click directo en las coordenadas guardadas de un ID del mapa: sin selectores ni busquedas. Verifica que el texto bajo el punto coincida (avisa si hay drift), que las coordenadas sean de esta pagina (no de otro juego) y si un overlay DOM tapa el punto (blockedBy). Con autoConfirm=true resuelve el modal de confirmacion que aparece despues (compras de bonus, etc.).",
      inputSchema: {
        id: z.string().describe("ID o numero del mapa (ej: spin, bet-up, buy-bonus, 7)"),
        strict: z.boolean().optional().describe("No hacer click si la UI cambio en ese punto"),
        autoConfirm: z.boolean().optional().describe("Tras el click, confirmar modal si aparece"),
        confirmTimeoutMs: z.number().int().min(200).max(15000).optional(),
        waitForNetwork: z
          .string()
          .optional()
          .describe('Regex de la respuesta a esperar. "" usa network.spinEndpoint. Ej: "/spin|/buy"'),
        settleMs: z.number().int().min(0).max(30000).optional().describe("Espera extra tras el click"),
      },
    },
    async ({ id, strict, autoConfirm, confirmTimeoutMs, waitForNetwork, settleMs }) => {
      try {
        const res = await session.clickId(id, {
          strict,
          autoConfirm,
          confirmTimeoutMs,
          waitForNetwork,
          settleMs,
        });
        return res.ok && !res.warning
          ? show("Click por coordenada", res)
          : { ...show("Click por coordenada", res), isError: !res.ok };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_confirm",
    {
      title: "Confirmar modal",
      description:
        "Busca y pulsa el boton de confirmacion visible (confirmar/comprar/aceptar/si...). Prioriza botones dentro de dialogos. Configurable en labels.confirm.",
      inputSchema: {
        labels: z.array(z.string()).optional().describe("Textos alternativos a considerar"),
        timeoutMs: z.number().int().min(200).max(15000).optional(),
      },
    },
    async ({ labels, timeoutMs }) => {
      try {
        const res = await session.confirmClick({ labels, timeoutMs });
        return show(
          res.clicked ? `Confirmado: ${res.label}` : "No encontre boton de confirmacion visible.",
          res,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_status",
    {
      title: "Estado de la sesion",
      description:
        "Comprueba si hay navegador abierto, en que URL, cuantos mensajes de consola y peticiones se han capturado. Empieza siempre por aqui si no sabes el estado.",
      inputSchema: {},
    },
    async () => {
      try {
        const cfg = loadConfig();
        const page = session.page;
        const alive = !!page && !page.isClosed();
        return show("Estado de la sesion", {
          browserOpen: alive,
          url: alive ? page!.url() : null,
          title: alive ? await page!.title().catch(() => null) : null,
          frames: alive ? session.frames().length : 0,
          consoleMessages: session.consoleEntries.length,
          consoleErrors: session.consoleEntries.filter((e) => e.level === "error" || e.level === "pageerror")
            .length,
          networkRequests: session.netEntries.length,
          failedRequests: session.netEntries.filter((e) => !e.ok).length,
          tracing: session.tracing,
          configuredUrl: cfg.url || null,
          spinSelector: cfg.selectors.spin ?? null,
          spinEndpoint: cfg.network.spinEndpoint ?? null,
          configPath,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_open",
    {
      title: "Abrir el demo",
      description:
        "Lanza el navegador (Chrome/Edge instalado, o Chromium) y navega al demo. Si ya esta abierto, reutiliza la sesion. Con cdpUrl se engancha a un Chrome ya abierto con --remote-debugging-port (util para depurar mientras tu juegas).",
      inputSchema: {
        url: z.string().optional().describe("URL del demo. Si se omite usa slots.config.json"),
        headless: z.boolean().optional().describe("false para ver la ventana (recomendado en el primer arranque)"),
        cdpUrl: z.string().optional().describe("Ej: http://127.0.0.1:9222 para engancharse a un Chrome existente"),
        channel: z.enum(["msedge", "chrome"]).nullable().optional().describe("Navegador a usar"),
      },
    },
    async ({ url, headless, cdpUrl, channel }) => {
      try {
        const info = await session.open({ url, headless, cdpUrl, channel });
        return show("Navegador listo", {
          ...info,
          hint: "Siguiente paso: slots_discover para ver botones/campos, o slots_state para leer saldo/apuesta.",
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_close",
    {
      title: "Cerrar navegador",
      description: "Cierra el navegador y libera la sesion.",
      inputSchema: {},
    },
    async () => {
      await session.close();
      return ok("Sesion cerrada.");
    },
  );

  // ------------------------------------------------------------- inspeccion
  server.registerTool(
    "slots_discover",
    {
      title: "Descubrir elementos de la UI",
      description:
        "Lista frames y elementos interactivos visibles (botones, inputs, canvas, iframes) con id/clase/testid/aria-label/texto y posicion. Usalo para calibrar selectors.spin, selectors.balance, etc. en slots.config.json.",
      inputSchema: {},
    },
    async () => {
      try {
        const data = await session.discover();
        return show(
          `Encontrados ${data.elements.length} elementos y ${data.hints.length} pistas de texto en ${data.frames.length} frame(s)`,
          data,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_screenshot",
    {
      title: "Captura de pantalla",
      description:
        "Hace una captura de la pagina (o del canvas del juego) y la devuelve como imagen. Sirve para ver el estado visual de los rodillos.",
      inputSchema: {
        selector: z.string().optional().describe("Elemento a capturar; por defecto el canvas configurado"),
        fullPage: z.boolean().optional(),
        save: z.boolean().optional().describe("Guardar PNG en .slots-artifacts (default true)"),
      },
    },
    async ({ selector, fullPage, save }) => {
      try {
        const shot = await session.screenshot({ selector, fullPage, save });
        const content: ToolResult["content"] = [
          { type: "image", data: shot.base64, mimeType: "image/png" },
        ];
        if (shot.path) content.push({ type: "text", text: `Guardado en: ${shot.path}` });
        return { content };
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_console",
    {
      title: "Leer consola",
      description:
        "Devuelve mensajes de consola y excepciones de pagina capturados (incluye errores de iframes). Filtra por nivel o patron de texto y opcionalmente limpia el buffer.",
      inputSchema: {
        level: z
          .enum(["error", "warning", "log", "info", "debug", "pageerror", "crash"])
          .optional()
          .describe("Solo mensajes de este nivel"),
        pattern: z.string().optional().describe("Regex aplicada al texto"),
        limit: z.number().int().min(1).max(500).optional().describe("Cuantos mensajes devolver (los ultimos)"),
        clear: z.boolean().optional().describe("Vaciar el buffer despues de leer"),
      },
    },
    async ({ level, pattern, limit, clear }) => {
      try {
        let items = session.consoleEntries;
        if (level) items = items.filter((e) => e.level === level);
        if (pattern) {
          const re = new RegExp(pattern, "i");
          items = items.filter((e) => re.test(e.text));
        }
        const sliced = items.slice(-(limit ?? 100));
        const counts = session.consoleEntries.reduce<Record<string, number>>((acc, e) => {
          acc[e.level] = (acc[e.level] ?? 0) + 1;
          return acc;
        }, {});
        if (clear) session.consoleEntries = [];
        return show(`Mensajes de consola (${sliced.length} de ${items.length})`, {
          totalsByLevel: counts,
          messages: sliced,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_network",
    {
      title: "Inspeccionar red",
      description:
        "Lista peticiones HTTP capturadas (metodo, URL, status, bytes) con filtros. Con includeBodies devuelve los cuerpos; bodySide elige request, response o ambos. raw=true anade base64/hex exactos (los binarios siempre los llevan), asi no se corrompen los payloads de motores que usan protocolos binarios.",
      inputSchema: {
        urlPattern: z.string().optional().describe("Regex sobre la URL"),
        method: z.string().optional(),
        onlyErrors: z.boolean().optional().describe("Solo fallidas o status >= 400"),
        includeBodies: z.boolean().optional(),
        bodySide: z
          .enum(["request", "response", "both"])
          .optional()
          .describe("Lado del cuerpo a incluir (default response)"),
        raw: z.boolean().optional().describe("Incluir base64/hex exactos tambien en texto/JSON"),
        maxBodyChars: z.number().int().min(100).max(200000).optional().describe("Tope de texto por cuerpo (default 2500)"),
        bodyLimit: z.number().int().min(1).max(20).optional().describe("Cuantos cuerpos incluir (max 20)"),
        limit: z.number().int().min(1).max(500).optional(),
        headerContains: z.string().optional().describe("Regex sobre headers de la respuesta (requiere includeBodies)"),
      },
    },
    async ({ urlPattern, method, onlyErrors, includeBodies, bodySide, raw, maxBodyChars, bodyLimit, limit, headerContains }) => {
      try {
        let items = session.netEntries;
        if (urlPattern) {
          const re = new RegExp(urlPattern, "i");
          items = items.filter((e) => re.test(e.url));
        }
        if (method) items = items.filter((e) => e.method === method.toUpperCase());
        if (onlyErrors) items = items.filter((e) => !e.ok || (e.status ?? 0) >= 400);

        const sliced = items.slice(-(limit ?? 60));
        const bodies: Array<Record<string, unknown>> = [];
        if (includeBodies) {
          const side = bodySide ?? "response";
          const candidates = sliced.filter((e) => (e.status ?? 0) >= 200 && (e.status ?? 0) < 400);
          for (const entry of candidates.slice(-(bodyLimit ?? 5))) {
            if (headerContains) {
              const headers = await session.headersFor(entry.id);
              const re = new RegExp(headerContains, "i");
              if (!headers || !re.test(JSON.stringify(headers))) continue;
            }
            const bodyOpts = { maxChars: maxBodyChars ?? 2500, includeRaw: raw ?? false };
            const record: Record<string, unknown> = {
              id: entry.id,
              method: entry.method,
              url: entry.url,
              status: entry.status,
              reqBytes: entry.reqBytes,
              resBytes: entry.resBytes,
            };
            if (side !== "request") {
              const view = await session.bodyView(entry.id, bodyOpts);
              if (view) record.response = view;
            }
            if (side !== "response") {
              const view = await session.requestView(entry.id, bodyOpts);
              if (view) record.request = view;
            }
            if (!record.request && !record.response) continue;
            bodies.push(record);
          }
        }

        return show(`Peticiones (${sliced.length} de ${items.length})`, {
          requests: sliced,
          bodies: includeBodies ? bodies : undefined,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_network_export",
    {
      title: "Exportar red a JSON",
      description:
        "Vuelca todas las peticiones capturadas (request + response en crudo: JSON, texto o base64/hex) a un archivo JSON en .slots-artifacts. Es el volcado completo para documentar un BSF.",
      inputSchema: {
        urlPattern: z.string().optional(),
        includeBodies: z.boolean().optional().describe("Incluir cuerpos (default true)"),
        bodyLimit: z.number().int().min(1).max(500).optional(),
        maxBodyChars: z.number().int().min(100).max(200000).optional(),
      },
    },
    async ({ urlPattern, includeBodies, bodyLimit, maxBodyChars }) => {
      try {
        const cfg = loadConfig();
        const re = urlPattern ? new RegExp(urlPattern, "i") : null;
        const items = session.netEntries.filter((e) => (re ? re.test(e.url) : true));
        const withBodies: Array<Record<string, unknown>> = [];
        if (includeBodies !== false) {
          for (const entry of items.slice(-(bodyLimit ?? 100))) {
            const opts = { maxChars: maxBodyChars ?? 8000, includeRaw: true };
            const response = await session.bodyView(entry.id, opts);
            const request = await session.requestView(entry.id, opts);
            if (!response && !request) continue;
            withBodies.push({ ...entry, request: request ?? undefined, response: response ?? undefined });
          }
        }
        const file = artifactPath(cfg.artifactsDir, "network", "json");
        fs.writeFileSync(
          file,
          JSON.stringify(
            {
              capturedAt: new Date().toISOString(),
              url: session.page?.url() ?? null,
              requests: includeBodies !== false ? withBodies : items,
            },
            null,
            2,
          ),
        );
        return ok(`Exportadas ${items.length} peticiones (${withBodies.length} con cuerpos) a:\n${file}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ juego
  server.registerTool(
    "slots_state",
    {
      title: "Leer estado (saldo/apuesta/ganancia)",
      description:
        "Lee saldo, apuesta y ganancia desde los selectores configurados, con heuristica de texto como respaldo. Devuelve tambien la URL y el frame donde encontro los datos.",
      inputSchema: {},
    },
    async () => {
      try {
        return show("Estado leido", await session.readState());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_click",
    {
      title: "Click en un elemento",
      description:
        "Hace click por selector CSS, rol+nombre accesible o texto, buscando en todos los frames. Si un overlay bloquea el click, lo reintenta despachando el evento.",
      inputSchema: {
        selector: z.string().optional(),
        role: z
          .enum(["button", "link", "slider", "spinbutton", "textbox", "img", "radio", "checkbox"])
          .optional(),
        name: z.string().optional().describe("Nombre accesible (aria-label / texto)"),
        text: z.string().optional(),
        exact: z.boolean().optional(),
        timeoutMs: z.number().int().min(500).max(60000).optional(),
      },
    },
    async ({ selector, role, name, text, exact, timeoutMs }) => {
      try {
        const res = await session.click({ selector, role, name, text, exact, timeoutMs });
        if (!res.ok) {
          return {
            ...ok(
              "No encontre el elemento. Prueba slots_discover y usa un selector CSS explicito o define selectors.* en la config.",
            ),
            isError: true,
          };
        }
        return show("Click realizado", res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_click_at",
    {
      title: "Click por coordenadas",
      description:
        "Hace click en coordenadas de viewport. Para juegos 100% canvas donde no hay botones en el DOM: saca las coordenadas de slots_screenshot/slots_discover. Si el juego esta en un iframe, indica frameUrlIncludes para sumar el offset.",
      inputSchema: {
        x: z.number(),
        y: z.number(),
        frameUrlIncludes: z.string().optional(),
      },
    },
    async ({ x, y, frameUrlIncludes }) => {
      try {
        return show("Click por coordenadas", await session.clickAt(x, y, { frameUrlIncludes }));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_set_bet",
    {
      title: "Cambiar apuesta",
      description:
        "Ajusta la apuesta usando los botones +/- configurados hasta alcanzar amount, o pulsa increments veces. Verifica la apuesta leida antes y despues.",
      inputSchema: {
        amount: z.number().positive().optional().describe("Apuesta objetivo"),
        increments: z.number().int().optional().describe("Numero de pulsaciones (negativo = bajar)"),
        direction: z.enum(["up", "down"]).optional(),
      },
    },
    async ({ amount, increments, direction }) => {
      try {
        const res = await session.setBet({ amount, increments, direction });
        return show("Apuesta ajustada", { ...res, hint: res.ok ? undefined : "No se alcanzo el objetivo; revisa selectors.betIncrease/betDecrease." });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_spin",
    {
      title: "Girar una vez",
      description:
        "Pulsa el boton de giro y espera a la respuesta de red del servidor (si spinEndpoint esta configurado) y a que cambie el saldo. Devuelve estado antes/despues, delta, payload del servidor y campos monetarios detectados.",
      inputSchema: {
        waitForNetwork: z.boolean().optional(),
        settleMs: z.number().int().min(0).max(30000).optional().describe("Espera extra tras el giro para animaciones"),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
      },
    },
    async ({ waitForNetwork, settleMs, timeoutMs }) => {
      try {
        const res = await session.locked(() => session.spin({ waitForNetwork, settleMs, timeoutMs }));
        return show("Resultado del giro", res);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_run_session",
    {
      title: "Sesion de N giros + analisis",
      description:
        "Ejecuta N giros seguidos, guarda cada resultado en JSONL y calcula estadisticas de QA: RTP observado, tasa de acierto, multiplicadores, volatilidad y errores. No modifica el RNG: solo juega como un usuario y mide.",
      inputSchema: {
        spins: z.number().int().min(1).max(500).describe("Cantidad de giros"),
        delayMs: z.number().int().min(0).max(60000).optional().describe("Pausa entre giros (default 400)"),
        settleMs: z.number().int().min(0).max(30000).optional(),
        stopOnError: z.boolean().optional().describe("Detener al primer error (default true)"),
      },
    },
    async ({ spins, delayMs, settleMs, stopOnError }) => {
      try {
        const cfg = loadConfig();
        const results = await session.locked(async () => {
          const records: Array<Record<string, unknown>> = [];
          const startedAt = Date.now();
          for (let i = 1; i <= spins; i++) {
            try {
              const spin = await session.spin({ settleMs });
              const bet = spin.before.bet.value;
              let win = spin.after.win.value;
              let winSource = "selector-win";
              if (win == null && spin.delta != null && bet != null) {
                win = Number((spin.delta + bet).toFixed(2));
                winSource = "inferido (deltaSaldo + apuesta)";
              }
              if (win == null) winSource = "desconocido";

              records.push({
                i,
                t: new Date().toISOString(),
                bet,
                win: round(win),
                winSource,
                balanceBefore: round(spin.before.balance.value),
                balanceAfter: round(spin.after.balance.value),
                delta: spin.delta,
                spinMs: spin.durationMs,
                spinEndpoint: spin.network?.url ?? null,
                networkStatus: spin.network?.status ?? null,
                moneyFields: spin.moneyFields,
                payload: spin.payload?.json ?? spin.payload?.text ?? null,
              });
              if (delayMs !== 0) await new Promise((r) => setTimeout(r, delayMs ?? 400));
            } catch (err) {
              records.push({ i, t: new Date().toISOString(), error: err instanceof Error ? err.message : String(err) });
              if (stopOnError ?? true) break;
            }
          }
          return { records, startedAt, finishedAt: Date.now() };
        });

        const played = results.records.filter((r) => !r.error) as Array<{
          bet: number | null;
          win: number | null;
          winSource: string;
          i: number;
          delta: number | null;
          spinMs: number;
          balanceBefore: number | null;
          balanceAfter: number | null;
        }>;
        const errors = results.records.filter((r) => r.error);

        const bets = played.map((r) => r.bet).filter((n): n is number => typeof n === "number");
        const wins = played.map((r) => r.win).filter((n): n is number => typeof n === "number");
        const betTotal = bets.reduce((a, b) => a + b, 0);
        const winTotal = wins.reduce((a, b) => a + b, 0);
        const multipliers = played
          .filter((r) => typeof r.bet === "number" && r.bet > 0 && typeof r.win === "number")
          .map((r) => r.win! / r.bet!);

        const durationSec = (results.finishedAt - results.startedAt) / 1000;
        const balances = played
          .flatMap((r) => [r.delta])
          .filter((n): n is number => typeof n === "number");

        const balanceStart =
          played.find((r) => typeof r.balanceBefore === "number")?.balanceBefore ?? null;
        const balanceEnd =
          [...played].reverse().find((r) => typeof r.balanceAfter === "number")?.balanceAfter ?? null;
        const observedDelta =
          balanceStart != null && balanceEnd != null ? round(balanceEnd - balanceStart) : null;
        const declaredDelta = balances.length ? round(balances.reduce((a, b) => a + b, 0)) : null;
        const balanceMismatch =
          observedDelta != null && declaredDelta != null && Math.abs(observedDelta - declaredDelta) > 0.05;

        const stats = {
          spinsRequested: spins,
          spinsCompleted: played.length,
          errors: errors.length,
          durationSec: Number(durationSec.toFixed(1)),
          spinsPerMinute: Number(((played.length / Math.max(durationSec, 0.001)) * 60).toFixed(1)),
          betTotal: round(betTotal),
          winTotal: round(winTotal),
          rtp: betTotal > 0 ? Number(((winTotal / betTotal) * 100).toFixed(2)) : null,
          rtpNote:
            "RTP observado en muestra corta; la varianza es alta. Valido solo como smoke test, no como certificacion.",
          hitRate:
            multipliers.length > 0
              ? Number(((multipliers.filter((m) => m > 0).length / multipliers.length) * 100).toFixed(1))
              : null,
          maxWin: wins.length ? round(Math.max(...wins)) : null,
          maxMultiplier: multipliers.length ? Number(Math.max(...multipliers).toFixed(2)) : null,
          avgMultiplier: multipliers.length ? Number(mean(multipliers).toFixed(2)) : null,
          stdevMultiplier: multipliers.length ? Number(stdev(multipliers).toFixed(2)) : null,
          p95Multiplier: multipliers.length ? Number(percentile(multipliers, 95).toFixed(2)) : null,
          netDelta: balances.length ? round(balances.reduce((a, b) => a + b, 0)) : null,
          balanceStart,
          balanceEnd,
          balanceObservedDelta: observedDelta,
          winSources: [...new Set(played.map((r) => r.winSource))],
          warnings: [
            balanceMismatch
              ? `Descuadre: suma de deltas=${declaredDelta} vs saldo final-inicial=${observedDelta}. Suele indicar lectura de saldo antes de que termine la animacion (sube spin.settleMs) o giros solapados.`
              : null,
            played.length && played.some((r) => r.winSource.includes("inferido"))
              ? "Parte de las ganancias se infirieron desde el saldo: configura selectors.win para mayor precision."
              : null,
          ].filter(Boolean),
        };

        const file = artifactPath(cfg.artifactsDir, "session", "jsonl");
        fs.writeFileSync(file, results.records.map((r) => JSON.stringify(r)).join("\n"), "utf8");

        const top = [...played]
          .sort((a, b) => (b.win ?? 0) - (a.win ?? 0))
          .slice(0, 5)
          .map((r) => ({ spin: r.i, bet: r.bet, win: r.win, delta: r.delta }));

        return show("Sesion completada", {
          stats,
          topWins: top,
          firstErrors: errors.slice(0, 5),
          file,
          hint:
            stats.spinsCompleted < spins
              ? "La sesion se corto antes de tiempo: revisa firstErrors."
              : undefined,
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // -------------------------------------------------------------- auxiliares
  server.registerTool(
    "slots_wait",
    {
      title: "Esperar",
      description: "Espera un tiempo, a que aparezca un selector, a una URL o a networkidle.",
      inputSchema: {
        ms: z.number().int().min(0).max(120000).optional(),
        selector: z.string().optional(),
        urlIncludes: z.string().optional(),
        networkIdle: z.boolean().optional(),
      },
    },
    async (args) => {
      try {
        return show("Espera completada", await session.wait(args));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_eval",
    {
      title: "Evaluar JS en la pagina",
      description:
        "Ejecuta una expresion JS en el contexto de la pagina y devuelve el resultado. Util para leer variables del juego (window.gameState, etc.) o inspeccionar el DOM a mano.",
      inputSchema: {
        expression: z.string().describe("Expresion JS. Ej: \"Object.keys(window).filter(k=>/game|slot/i.test(k))\""),
        frameUrlIncludes: z.string().optional(),
      },
    },
    async ({ expression, frameUrlIncludes }) => {
      try {
        const page = session.ensurePage();
        const frame = frameUrlIncludes
          ? page.frames().find((f) => f.url().includes(frameUrlIncludes))
          : page.mainFrame();
        if (!frame) throw new Error(`No hay frame cuya URL incluya "${frameUrlIncludes}"`);
        const value = await frame.evaluate(expression);
        return show("Resultado de la evaluacion", {
          value: truncate(JSON.stringify(value, null, 2) ?? String(value), 20000),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_trace_start",
    {
      title: "Iniciar traza Playwright",
      description:
        "Empieza a grabar una traza (screenshots, snapshots DOM, fuentes) para analisis post-mortem de un bug.",
      inputSchema: {},
    },
    async () => {
      try {
        return ok(await session.startTrace());
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_trace_stop",
    {
      title: "Detener traza Playwright",
      description: "Guarda la traza en .slots-artifacts y devuelve la ruta. Se abre con: npx playwright show-trace <archivo>.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await session.stopTrace();
        return ok(`Traza guardada en:\n${res.path}\nAbrela con: npx playwright show-trace "${res.path}"`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "slots_config",
    {
      title: "Ver/editar configuracion",
      description:
        "Lee slots.config.json o aplica un patch parcial (selectores, endpoint de giro, URL). Se recarga en caliente sin reiniciar el MCP.",
      inputSchema: {
        patch: z.string().optional().describe("JSON parcial a fusionar. Ej: {\"selectors\":{\"spin\":\"#spin-btn\"}}"),
      },
    },
    async ({ patch }) => {
      try {
        if (!patch) {
          return show(`Configuracion actual (${configPath})`, loadConfig());
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(patch);
        } catch {
          throw new Error("patch no es JSON valido");
        }
        const updated = writeConfigPatch(parsed);
        return show(`Configuracion actualizada (${configPath})`, updated);
      } catch (err) {
        return fail(err);
      }
    },
  );

}

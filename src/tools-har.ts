import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { bodyText, decodeBody, loadHar, type HarEntry, type HarFile } from "./har/loader.js";
import { isApiEntry, opOf, summarizeHar } from "./har/summary.js";
import { buildElkCard, redactXml } from "./har/elk-card.js";
import { artifactPath, truncate } from "./util.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
  isError?: boolean;
};

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const show = (label: string, value: unknown): ToolResult => ok(`${label}\n${JSON.stringify(value, null, 2)}`);
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: `ERROR: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

function redactText(text: string | null, redact: boolean): string | null {
  if (text == null) return null;
  return redact ? redactXml(text) : text;
}

function entryView(entry: HarEntry, options: { includeBodies: boolean; maxBodyChars: number; redact: boolean }) {
  const base = {
    index: entry.index,
    at: entry.startedDateTime,
    method: entry.method,
    host: entry.host,
    path: entry.path,
    search: entry.search,
    status: entry.status,
    mimeType: entry.mimeType,
    bytes: entry.responseBytes,
    timeMs: Math.round(entry.timeMs),
    api: isApiEntry(entry),
    op: isApiEntry(entry) ? opOf(entry) : null,
  };
  if (!options.includeBodies) return base;
  const request = bodyText(entry, "request", options.maxBodyChars);
  const response = bodyText(entry, "response", options.maxBodyChars);
  return {
    ...base,
    request: request
      ? { ...request, text: redactText(request.text, options.redact) }
      : null,
    response: response
      ? { ...response, text: redactText(response.text, options.redact) }
      : null,
  };
}

export function registerHarTools(server: McpServer): void {
  // --------------------------------------------------------------- summary
  server.registerTool(
    "har_summary",
    {
      title: "Resumen de HAR",
      description:
        "Lee un HAR y devuelve hosts, endpoints, builds (bundle/build-N), juegos detectados y llamadas de API (capi/papi). Es el primer paso antes de derivar un adaptador.",
      inputSchema: {
        path: z.string().describe("Ruta absoluta o relativa del .har"),
        top: z.number().int().min(5).max(200).optional().describe("Cuantos hosts/endpoints listar (default 40)"),
        includeApi: z.boolean().optional().describe("Incluir el detalle de entradas capi/papi (default true)"),
      },
    },
    async ({ path: file, top, includeApi }) => {
      try {
        const har = loadHar(file);
        const summary = summarizeHar(har, { top });
        if (includeApi === false) delete (summary as { api?: unknown }).api;
        return show(`HAR ${path.basename(har.path)}`, summary);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------- api
  server.registerTool(
    "har_api",
    {
      title: "Llamadas de API del HAR",
      description:
        "Extrae solo las llamadas de protocolo (capi/papi) con cuerpos decodificados. Filtra por host/op. Por defecto oculta gamesession y playerhash; usa redact=false para verlos.",
      inputSchema: {
        path: z.string(),
        hostPattern: z.string().optional().describe("Regex sobre host o URL"),
        op: z.string().optional().describe("Ultima parte del path, ej. init, purchase, checkwin"),
        includeBodies: z.boolean().optional().describe("Default true"),
        maxBodyChars: z.number().int().min(200).max(200000).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        redact: z.boolean().optional().describe("Ocultar sesion/playerhash (default true)"),
      },
    },
    async ({ path: file, hostPattern, op, includeBodies, maxBodyChars, limit, redact }) => {
      try {
        const har = loadHar(file);
        let entries = har.entries.filter(isApiEntry);
        if (hostPattern) {
          const re = new RegExp(hostPattern, "i");
          entries = entries.filter((entry) => re.test(entry.host) || re.test(entry.url));
        }
        if (op) entries = entries.filter((entry) => (opOf(entry) ?? "").toLowerCase() === op.toLowerCase());
        const selected = entries.slice(0, limit ?? 50);
        return show(`API ${path.basename(har.path)}: ${selected.length} de ${entries.length}`, {
          entries: selected.map((entry) =>
            entryView(entry, {
              includeBodies: includeBodies !== false,
              maxBodyChars: maxBodyChars ?? 4000,
              redact: redact !== false,
            }),
          ),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ find
  server.registerTool(
    "har_find",
    {
      title: "Buscar en el HAR",
      description:
        "Busca por regex en URL y, opcionalmente, en cuerpos decodificados (request/response). Devuelve entradas con contexto y cuerpos truncados.",
      inputSchema: {
        path: z.string(),
        pattern: z.string().describe("Regex sobre URL"),
        bodyPattern: z.string().optional().describe("Regex sobre cuerpos decodificados"),
        limit: z.number().int().min(1).max(100).optional(),
        includeBodies: z.boolean().optional(),
        maxBodyChars: z.number().int().min(200).max(100000).optional(),
        redact: z.boolean().optional(),
      },
    },
    async ({ path: file, pattern, bodyPattern, limit, includeBodies, maxBodyChars, redact }) => {
      try {
        const har = loadHar(file);
        const urlRe = new RegExp(pattern, "i");
        const bodyRe = bodyPattern ? new RegExp(bodyPattern, "i") : null;
        const matches = har.entries.filter((entry) => {
          if (entry.isDataUri) return false;
          if (!urlRe.test(entry.url)) return false;
          if (!bodyRe) return true;
          const request = decodeBody(entry.requestBodyRaw, entry.requestEncoding) ?? "";
          const response = decodeBody(entry.responseBodyRaw, entry.responseEncoding) ?? "";
          return bodyRe.test(request) || bodyRe.test(response);
        });
        const selected = matches.slice(0, limit ?? 20);
        return show(`Coincidencias: ${matches.length}`, {
          entries: selected.map((entry) =>
            entryView(entry, {
              includeBodies: includeBodies !== false,
              maxBodyChars: maxBodyChars ?? 3000,
              redact: redact !== false,
            }),
          ),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------- elk import
  server.registerTool(
    "har_import_elk",
    {
      title: "Derivar ficha Elk desde HAR",
      description:
        "Convierte uno o varios HAR de Elk en la ficha del adaptador: transporte, ops observadas, betlevels/bmodes, RTP/maxwin, variantes, builds, revisiones, rondas con replay y auditoria de saldo. Sirve para 158 juegos con el mismo protocolo.",
      inputSchema: {
        paths: z.array(z.string()).min(1).max(20).describe("Rutas de los .har"),
        redact: z.boolean().optional().describe("Ocultar gamesession/playerhash (default true)"),
        maxChars: z.number().int().min(500).max(200000).optional().describe("Tamano de las muestras request/response"),
        save: z.boolean().optional().describe("Guardar la ficha en artifactsDir"),
      },
    },
    async ({ paths, redact, maxChars, save }) => {
      try {
        const hars: HarFile[] = paths.map((file) => loadHar(file));
        const card = buildElkCard(hars, { redact: redact !== false, maxChars });
        if (save) {
          const cfg = loadConfig();
          const file = artifactPath(cfg.artifactsDir, "elk-har-card", "json");
          fs.writeFileSync(file, JSON.stringify(card, null, 2), "utf8");
          return show(`Ficha guardada en ${file}`, card);
        }
        return show(`Ficha Elk derivada de ${hars.length} HAR`, card);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // --------------------------------------------------------------- export
  server.registerTool(
    "har_export",
    {
      title: "Exportar entradas del HAR",
      description:
        "Exporta a JSON las entradas que cumplen un patron de URL, con cuerpos decodificados. Util para compartir evidencia sin el HAR completo (81 MB) y sin datos de sesion.",
      inputSchema: {
        path: z.string(),
        pattern: z.string().optional().describe("Regex sobre URL (default: todo)"),
        limit: z.number().int().min(1).max(5000).optional(),
        includeBodies: z.boolean().optional().describe("Default true"),
        redact: z.boolean().optional().describe("Default true"),
      },
    },
    async ({ path: file, pattern, limit, includeBodies, redact }) => {
      try {
        const har = loadHar(file);
        const re = pattern ? new RegExp(pattern, "i") : null;
        const entries = har.entries
          .filter((entry) => !entry.isDataUri && (!re || re.test(entry.url)))
          .slice(0, limit ?? 500);
        const payload = {
          schema: "deep-slots/har-export/v1",
          source: path.basename(har.path),
          generatedAt: new Date().toISOString(),
          count: entries.length,
          entries: entries.map((entry) =>
            entryView(entry, {
              includeBodies: includeBodies !== false,
              maxBodyChars: 200_000,
              redact: redact !== false,
            }),
          ),
        };
        const cfg = loadConfig();
        const out = artifactPath(cfg.artifactsDir, "har-export", "json");
        fs.writeFileSync(out, JSON.stringify(payload, null, 2), "utf8");
        return show(`Exportadas ${entries.length} entradas a ${out}`, {
          file: out,
          count: entries.length,
          bytes: fs.statSync(out).size,
          preview: truncate(JSON.stringify(payload.entries.slice(0, 3), null, 2), 2000),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

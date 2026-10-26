import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { redactSession } from "./elk/client.js";
import type { ElkRegistry } from "./elk/registry.js";
import type { ElkGameSession } from "./elk/session.js";
import { truncate } from "./util.js";

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

const ELK_OPS = [
  "init",
  "purchase",
  "claim",
  "reject",
  "checkwin",
  "sessionupdate",
  "replay",
  "fetchbalance",
  "saveround",
] as const;

type AttrValue = string | number | boolean;

function attrMap(value: Record<string, AttrValue> | undefined): Record<string, AttrValue> {
  return value ?? {};
}

function sessionOrThrow(registry: ElkRegistry, id: string | undefined): ElkGameSession {
  return registry.get(id);
}

export function registerElkTools(server: McpServer, registry: ElkRegistry): void {
  // ------------------------------------------------------------------ init
  server.registerTool(
    "elk_init",
    {
      title: "Abrir sesion Elk (capi XML)",
      description:
        "Abre una sesion demo contra el capi XML de Elk y devuelve la ficha del juego: betlevels, bmodes (DEF + X01..X05), RTP, maxwin, minspindelay y features. Usa origin+gameId o baseUrl completa. No abre navegador ni usa pixeles.",
      inputSchema: {
        gameId: z.string().optional().describe("gameid de Elk (ej. 10222 Cluster Kingdom, 10266 Pirots 5)"),
        origin: z.string().optional().describe("Host del capi (default https://gc5-stage.contentmedia.eu)"),
        baseUrl: z.string().optional().describe("URL completa .../capi/{gameId}/play; tiene prioridad sobre origin+gameId"),
        operatorId: z.string().optional().describe("opid del operador demo (default 44)"),
        currency: z.string().optional(),
        locale: z.string().optional().describe("lang del init (default en_gb)"),
        mode: z.enum(["play", "real", "replay"]).optional(),
        variant: z.string().optional().describe("Variante que exige el juego (Pirots 5 = nest); se ecoa en purchase"),
        screenres: z.string().optional(),
        id: z.string().optional().describe("Nombre local de la sesion"),
        clientVersion: z.string().optional().describe("Cabecera X-CLIENT-VERSION (build del juego)"),
        ecfVersion: z.string().optional().describe("Cabecera X-ECF-VERSION (build del shell)"),
        query: z.record(z.string(), z.string()).optional().describe("Parametros de query extra"),
        initAttrs: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Atributos extra para el <request> de init"),
        timeoutMs: z.number().int().min(1000).max(120000).optional(),
        retries: z.number().int().min(0).max(5).optional(),
      },
    },
    async ({ gameId, origin, baseUrl, operatorId, currency, locale, mode, variant, screenres, id, clientVersion, ecfVersion, query, initAttrs, timeoutMs, retries }) => {
      try {
        const cfg = loadConfig();
        const resolvedGameId = gameId ?? (cfg.elk.gameId || undefined);
        if (!baseUrl && (!origin && !cfg.elk.origin)) throw new Error("falta origin/baseUrl");
        if (!baseUrl && resolvedGameId == null) {
          throw new Error("falta gameId (o define elk.gameId en slots.config.json)");
        }
        const session = registry.create(id ?? `elk-${resolvedGameId ?? "session"}`, {
          baseUrl,
          origin: origin ?? cfg.elk.origin,
          gameId: resolvedGameId,
          operatorId: operatorId ?? cfg.elk.operatorId,
          currency: currency ?? cfg.elk.currency,
          locale: locale ?? cfg.elk.locale,
          mode: mode ?? "play",
          variant,
          screenres,
          clientVersion: clientVersion ?? cfg.elk.clientVersion,
          ecfVersion: ecfVersion ?? cfg.elk.ecfVersion,
          query,
          timeoutMs: timeoutMs ?? cfg.elk.timeoutMs,
          retries: retries ?? cfg.elk.retries,
        });
        const info = await session.initialize(attrMap(initAttrs));
        return show(`Sesion Elk '${session.id}' abierta (gameId=${session.gameId})`, {
          status: session.status(),
          card: session.card(),
          declared: {
            gamesession: redactSession(info.gamesession),
            betlevels: info.betlevels.length,
            bmodes: info.bmodes.map((bmode) => `${bmode.id}=${bmode.display}`).join(" "),
            currency: info.currency,
            balance: info.balance,
          },
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------------------------------------------------------------- status
  server.registerTool(
    "elk_status",
    {
      title: "Estado de sesiones Elk",
      description:
        "Lista las sesiones Elk abiertas con saldo, betlevel por defecto, minspindelay, rondas jugadas y RTP observado. Con id muestra solo esa sesion.",
      inputSchema: {
        id: z.string().optional(),
        includeLastCalls: z.number().int().min(0).max(20).optional().describe("Cuantas llamadas recientes incluir"),
      },
    },
    async ({ id, includeLastCalls }) => {
      try {
        const sessions = id ? [sessionOrThrow(registry, id)] : registry.list();
        if (!sessions.length) return ok("No hay sesiones Elk. Usa elk_init.");
        const payload = sessions.map((session) => ({
          ...session.status(),
          recentCalls:
            includeLastCalls && includeLastCalls > 0
              ? session.client.calls.slice(-includeLastCalls).map((call) => ({
                  op: call.op,
                  status: call.status,
                  ms: call.ms,
                  errorcode: call.errorcode,
                  error: call.error,
                }))
              : undefined,
        }));
        return show(`Sesiones Elk (${payload.length})`, payload);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ bets
  server.registerTool(
    "elk_bets",
    {
      title: "Tabla de apuestas Elk",
      description:
        "Devuelve la matriz betlevel x bmode con importes reales del init. DEF es el giro normal; X01..X05 son compras de feature (3x, 10x, 50x, 100x, 500x).",
      inputSchema: {
        id: z.string().optional(),
        betlevel: z.number().int().min(1).max(64).optional().describe("Filtrar un nivel"),
      },
    },
    async ({ id, betlevel }) => {
      try {
        const session = sessionOrThrow(registry, id);
        const table = session.betTable().filter((entry) => (betlevel ? entry.betlevel === betlevel : true));
        return show(`Apuestas ${session.id} (gameId=${session.gameId})`, table);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ spin
  server.registerTool(
    "elk_spin",
    {
      title: "Girar (purchase) en Elk",
      description:
        "Ejecuta un purchase. bmode=DEF es el giro normal; X01..X05 compra features. Cierra con checkwin y valida que saldo_final = saldo_inicial - apuesta + premio. Devuelve el replay (clientseed, revision, results, actions).",
      inputSchema: {
        id: z.string().optional(),
        betlevel: z.number().int().min(1).max(64).optional(),
        bmode: z.string().optional().describe("DEF por defecto; X01..X05 para feature buy"),
        settle: z.boolean().optional().describe("Cerrar con checkwin (default true)"),
        gamespeed: z.enum(["normal", "quick"]).optional(),
        pmode: z.string().optional(),
        extraDelayMs: z.number().int().min(0).max(60000).optional().describe("Pausa adicional anti-429"),
        extra: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Atributos extra para purchase (avanzado)"),
      },
    },
    async ({ id, betlevel, bmode, settle, gamespeed, pmode, extraDelayMs, extra }) => {
      try {
        const session = sessionOrThrow(registry, id);
        const outcome = await session.spin({ betlevel, bmode, settle, gamespeed, pmode, extraDelayMs, extra });
        return show(
          outcome.ok ? `Giro ${outcome.round?.index ?? "?"} OK` : `Giro fallido: ${outcome.error}`,
          {
            ok: outcome.ok,
            error: outcome.error,
            errorcode: outcome.errorcode,
            balance: outcome.balance,
            round: outcome.round,
          },
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------- run
  server.registerTool(
    "elk_run",
    {
      title: "Sesion de N giros Elk",
      description:
        "Repite purchase+checkwin N veces con el mismo betlevel/bmode, respetando minspindelay y validando el saldo en cada ronda. Corta ante el primer error o mismatch (configurable). Devuelve RTP observado y resumen de rondas.",
      inputSchema: {
        id: z.string().optional(),
        spins: z.number().int().min(1).max(10000),
        betlevel: z.number().int().min(1).max(64).optional(),
        bmode: z.string().optional(),
        settle: z.boolean().optional().describe("checkwin por ronda (default true)"),
        extraDelayMs: z.number().int().min(0).max(60000).optional(),
        stopOnMismatch: z.boolean().optional().describe("Cortar si el saldo no cuadra (default true)"),
        stopOnError: z.boolean().optional().describe("Cortar ante el primer error (default true)"),
      },
    },
    async ({ id, spins, betlevel, bmode, settle, extraDelayMs, stopOnMismatch, stopOnError }) => {
      try {
        const session = sessionOrThrow(registry, id);
        const result = await session.run({ spins, betlevel, bmode, settle, extraDelayMs, stopOnMismatch, stopOnError });
        return show(`Run ${session.id}: ${result.completed}/${result.spins} giros`, {
          result,
          status: session.status(),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ---------------------------------------------------------------- settle
  server.registerTool(
    "elk_settle",
    {
      title: "Cerrar ronda pendiente (checkwin)",
      description:
        "Ejecuta checkwin sobre la ultima ronda sin cerrar, actualiza el saldo y valida la contabilidad. Util si giraste con settle=false.",
      inputSchema: {
        id: z.string().optional(),
        roundid: z.string().optional().describe("Round concreto; por defecto la ultima ronda pendiente"),
      },
    },
    async ({ id, roundid }) => {
      try {
        const session = sessionOrThrow(registry, id);
        const target = roundid ? session.rounds.find((round) => round.roundid === roundid) : undefined;
        if (roundid && !target) throw new Error(`ronda ${roundid} no encontrada en la sesion`);
        const result = await session.settle(target);
        return show(result.ok ? "Ronda cerrada y validada" : "Ronda cerrada con incidencias", result);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------------ card
  server.registerTool(
    "elk_card",
    {
      title: "Ficha de capacidad Elk (BSF)",
      description:
        "Devuelve la ficha del adaptador: transporte, ops, apuestas, RTP/maxwin declarados, features, pacing, replay de la ultima ronda y validacion contable. Es el contrato que se replica para los 158 juegos Elk.",
      inputSchema: {
        id: z.string().optional(),
        save: z.boolean().optional().describe("Guardar la ficha en artifactsDir"),
      },
    },
    async ({ id, save }) => {
      try {
        const session = sessionOrThrow(registry, id);
        const card = session.card();
        if (save) {
          const fs = await import("node:fs");
          const cfg = loadConfig();
          const dir = cfg.artifactsDir;
          fs.mkdirSync(dir, { recursive: true });
          const file = `${dir}/elk-card-${session.id}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
          fs.writeFileSync(file, JSON.stringify(card, null, 2), "utf8");
          return show(`Ficha guardada en ${file}`, card);
        }
        return show(`Ficha Elk ${session.id}`, card);
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ------------------------------------------------------------- raw call
  server.registerTool(
    "elk_call",
    {
      title: "Llamada cruda al capi Elk",
      description:
        "Ejecuta cualquier op del capi con atributos arbitrarios (init, purchase, claim, reject, checkwin, sessionupdate, replay, fetchbalance, saveround). Inyecta gamesession cuando falta. Para descubrir contratos que las tools de alto nivel no cubren.",
      inputSchema: {
        id: z.string().optional(),
        op: z.enum(ELK_OPS),
        attrs: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Atributos del <request>"),
        maxChars: z.number().int().min(200).max(200000).optional(),
        allowErrorCodes: z.array(z.number().int()).optional().describe("errorcodes que no deben lanzar"),
      },
    },
    async ({ id, op, attrs, maxChars, allowErrorCodes }) => {
      try {
        const session = sessionOrThrow(registry, id);
        if (!session.info) throw new Error("sesion sin init: llama a elk_init primero");
        const merged: Record<string, AttrValue> = { ...(attrs ?? {}) };
        if (!("gamesession" in merged) && op !== "init") merged.gamesession = session.info.gamesession;
        const result = await session.client.call(op, merged, {
          tolerate: allowErrorCodes ?? [],
          throwOnError: false,
        });
        session.calls.push(result);
        const limit = maxChars ?? 8000;
        return show(`elk_call ${op} -> errorcode=${result.errorcode}`, {
          ok: result.errorcode === 0,
          op: result.op,
          url: result.url,
          status: result.status,
          ms: result.ms,
          errorcode: result.errorcode,
          method: result.method,
          error: result.error,
          request: truncate(result.request, limit),
          response: truncate(result.response, limit),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );

  // ----------------------------------------------------------------- close
  server.registerTool(
    "elk_close",
    {
      title: "Cerrar sesiones Elk",
      description: "Descarta una sesion Elk o todas. No hay recursos del navegador que liberar; solo se pierde el gamesession local.",
      inputSchema: {
        id: z.string().optional().describe("Sesion a cerrar; sin id cierra todas"),
      },
    },
    async ({ id }) => {
      try {
        const closed = registry.close(id);
        return show(closed.length ? `Sesiones cerradas: ${closed.join(", ")}` : "No habia sesiones que cerrar", {
          closed,
          remaining: registry.list().map((session) => session.id),
        });
      } catch (err) {
        return fail(err);
      }
    },
  );
}

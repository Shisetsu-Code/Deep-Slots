import { parseXml, xmlAttr, xmlText, type XmlNode } from "../elk/xml.js";
import { elkFamilyKey, parseBalance, parseInit, parsePurchase, money, type ElkInitInfo } from "../elk/types.js";
import { decodeBody, type HarEntry, type HarFile } from "./loader.js";
import { isApiEntry, opOf } from "./summary.js";

export type HarElkRound = {
  roundid: string;
  betlevel: number;
  bmode: string;
  betamount: number;
  winamount: number;
  balanceAfterPurchase: number | null;
  balanceAfterCheckwin: number | null;
  balanceExpectedAfterWin: number | null;
  balanced: boolean | null;
  seed: string | null;
  revision: string | null;
  results: number;
  modes: string[];
  actions: string[];
  variant: string | null;
};

export type HarElkGame = {
  gameId: string;
  familyKey: string;
  names: string[];
  slugs: string[];
  operatorIds: string[];
  variants: string[];
  builds: string[];
  revisions: string[];
  transport: {
    protocol: "xml-http";
    baseUrls: string[];
    ops: string[];
    contentType: string;
    headers: Record<string, string>;
  };
  declared: {
    rtp: number | null;
    maxwin: number | null;
    hf: number | null;
    currency: string | null;
    minspindelay: number | null;
    betlevels: number;
    bmodes: Array<{ id: string; display: string; multiplier: number | null }>;
    betModes: string[];
    featureBuys: string[];
    features: Record<string, unknown>;
    papi: string | null;
  } | null;
  bets: Array<{ betlevel: number; bmodes: Record<string, number> }>;
  ops: Record<string, number>;
  rounds: HarElkRound[];
  observed: {
    rounds: number;
    totalBet: number;
    totalWin: number;
    rtpObservedPct: number | null;
    hits: number;
    biggestWin: number;
  };
  balanceAudit: {
    checked: number;
    ok: number;
    failures: Array<{ roundid: string; expected: number; actual: number }>;
  };
  papi: {
    hosts: string[];
    ops: Record<string, number>;
    entries: Array<{ path: string; status: number; bytes: number; snippet: string | null }>;
  };
  samples: Record<string, { request: string | null; response: string | null }>;
  executionSupported: boolean;
  notes: string[];
};

export type HarElkCard = {
  schema: "deep-slots/har-elk/v1";
  files: Array<{ path: string; sizeMB: number; entries: number; apiEntries: number }>;
  generatedAt: string;
  games: HarElkGame[];
  builds: Array<{ bundle: string; build: string; count: number }>;
  apiEndpoints: Array<{ method: string; host: string; path: string; op: string | null; count: number; statuses: number[] }>;
  notes: string[];
};

type RequestAttrs = Record<string, string>;

function requestAttrs(body: string | null): RequestAttrs | null {
  if (!body) return null;
  try {
    const root = parseXml(body);
    const req = (root.request ?? root) as XmlNode;
    const attrs: RequestAttrs = {};
    for (const [key, value] of Object.entries(req)) {
      if (!key.startsWith("@") || value == null) continue;
      attrs[key.slice(1)] = String(value);
    }
    return attrs;
  } catch {
    return null;
  }
}

function mask(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

/** Oculta sesion y playerhash; los seeds del replay se conservan. */
export function redactXml(text: string): string {
  return text
    .replace(/(gamesession=")([^"]+)(")/gi, (_m, a: string, v: string, c: string) => `${a}${mask(v)}${c}`)
    .replace(/(<id>)([A-Za-z0-9]{20,})(<\/id>)/g, (_m, a: string, v: string, c: string) => `${a}${mask(v)}${c}`)
    .replace(/(<playerhash>)([^<]+)(<\/playerhash>)/gi, "$1<redacted>$3");
}

function redactBody(text: string | null, redact: boolean): string | null {
  if (text == null) return null;
  return redact ? redactXml(text) : text;
}

function snippet(text: string | null): string | null {
  if (!text) return null;
  return text.replace(/\s+/g, " ").slice(0, 220);
}

function gameIdOf(entry: HarEntry): string | null {
  return (
    /\/capi\/(\d+)\//.exec(entry.path)?.[1] ??
    /\/games\/(\d+)/.exec(entry.path)?.[1] ??
    entry.query.gameid?.[0] ??
    null
  );
}

function slugOf(entry: HarEntry): string | null {
  return (
    /^\/([a-z0-9][a-z0-9_-]*)\/build-\d+/i.exec(entry.path)?.[1] ??
    /\/games\/([a-z0-9-]+)\//i.exec(entry.path)?.[1] ??
    null
  );
}

type MutableGame = Omit<HarElkGame, "observed" | "balanceAudit" | "executionSupported" | "familyKey"> & {
  initInfo: ElkInitInfo | null;
  checkwins: Map<string, number>;
  purchasesByRound: Map<string, { betamount: number; winamount: number; balanceAfterPurchase: number | null; bmode: string }>;
};

function newGame(gameId: string): MutableGame {
  return {
    gameId,
    names: [],
    slugs: [],
    operatorIds: [],
    variants: [],
    builds: [],
    revisions: [],
    transport: { protocol: "xml-http", baseUrls: [], ops: [], contentType: "text/xml; charset=utf-8", headers: {} },
    declared: null,
    bets: [],
    ops: {},
    rounds: [],
    papi: { hosts: [], ops: {}, entries: [] },
    samples: {},
    notes: [],
    initInfo: null,
    checkwins: new Map(),
    purchasesByRound: new Map(),
  };
}

function uniqPush(list: string[], value: string | null | undefined): void {
  if (!value) return;
  if (!list.includes(value)) list.push(value);
}

function rememberSample(
  game: MutableGame,
  key: string,
  entry: HarEntry,
  redact: boolean,
  maxChars: number,
): void {
  if (game.samples[key]) return;
  const request = redactBody(decodeBody(entry.requestBodyRaw, entry.requestEncoding), redact);
  const response = redactBody(decodeBody(entry.responseBodyRaw, entry.responseEncoding), redact);
  game.samples[key] = {
    request: request ? request.slice(0, maxChars) : null,
    response: response ? response.slice(0, maxChars) : null,
  };
}

function finalize(game: MutableGame): HarElkGame {
  const rounds = game.rounds;
  const totalBet = rounds.reduce((acc, round) => acc + round.betamount, 0);
  const totalWin = rounds.reduce((acc, round) => acc + round.winamount, 0);
  const failures: Array<{ roundid: string; expected: number; actual: number }> = [];

  for (const round of rounds) {
    if (round.balanceAfterCheckwin == null || round.balanceAfterPurchase == null) {
      round.balanced = null;
      continue;
    }
    const expected = money(round.balanceAfterPurchase + round.winamount);
    round.balanceExpectedAfterWin = expected;
    if (Math.abs(expected - round.balanceAfterCheckwin) <= 0.005) {
      round.balanced = true;
    } else if (Math.abs(round.balanceAfterPurchase - round.balanceAfterCheckwin) <= 0.005) {
      // El operador acredito el premio ya en purchase.
      round.balanced = true;
    } else {
      round.balanced = false;
      failures.push({ roundid: round.roundid, expected, actual: round.balanceAfterCheckwin });
    }
  }

  const checked = rounds.filter((round) => round.balanced != null).length;
  const ok = rounds.filter((round) => round.balanced === true).length;
  const { initInfo, checkwins: _checkwins, purchasesByRound: _purchases, ...base } = game;

  return {
    ...base,
    familyKey: elkFamilyKey(
      initInfo
        ? {
            rtp: initInfo.rtp,
            maxwin: initInfo.maxwin,
            betlevels: initInfo.betlevels.length,
            bmodes: initInfo.betModes,
            features: initInfo.features,
          }
        : null,
      game.variants[0] ?? null,
    ),
    declared: initInfo
      ? {
          rtp: initInfo.rtp,
          maxwin: initInfo.maxwin,
          hf: initInfo.hf,
          currency: initInfo.currency,
          minspindelay: initInfo.minspindelay,
          betlevels: initInfo.betlevels.length,
          bmodes: initInfo.bmodes,
          betModes: initInfo.betModes,
          featureBuys: initInfo.betModes.filter((id) => id !== "DEF"),
          features: initInfo.features,
          papi: initInfo.papi,
        }
      : null,
    observed: {
      rounds: rounds.length,
      totalBet: money(totalBet),
      totalWin: money(totalWin),
      rtpObservedPct: totalBet > 0 ? Number(((totalWin / totalBet) * 100).toFixed(2)) : null,
      hits: rounds.filter((round) => round.winamount > 0).length,
      biggestWin: money(rounds.reduce((acc, round) => Math.max(acc, round.winamount), 0)),
    },
    balanceAudit: { checked, ok, failures },
    executionSupported:
      Boolean(initInfo && initInfo.betlevels.length > 0) &&
      (game.ops.purchase ?? 0) > 0 &&
      (game.ops.init ?? 0) > 0,
  };
}

/**
 * Deriva una ficha de adaptador Elk desde uno o varios HAR. No necesita red:
 * todo sale de las requests/responses capturadas.
 */
export function buildElkCard(
  hars: HarFile[],
  options: { redact?: boolean; maxChars?: number; maxPapiEntries?: number } = {},
): HarElkCard {
  const redact = options.redact !== false;
  const maxChars = options.maxChars ?? 6000;
  const maxPapiEntries = options.maxPapiEntries ?? 10;
  const games = new Map<string, MutableGame>();
  const builds = new Map<string, { bundle: string; build: string; count: number }>();
  const endpoints = new Map<string, { method: string; host: string; path: string; op: string | null; count: number; statuses: number[] }>();
  const notes: string[] = [];

  for (const har of hars) {
    for (const entry of har.entries) {
      if (entry.isDataUri) continue;

      const buildMatch = /\/([a-z0-9][a-z0-9_-]*)\/build-(\d+)/i.exec(entry.path);
      if (buildMatch) {
        const key = `${buildMatch[1]}@${buildMatch[2]}`;
        const build = builds.get(key) ?? { bundle: buildMatch[1]!, build: buildMatch[2]!, count: 0 };
        build.count++;
        builds.set(key, build);
      }

      if (isApiEntry(entry)) {
        const key = `${entry.method} ${entry.host}${entry.path}`;
        const endpoint = endpoints.get(key) ?? {
          method: entry.method,
          host: entry.host,
          path: entry.path,
          op: opOf(entry),
          count: 0,
          statuses: [],
        };
        endpoint.count++;
        if (!endpoint.statuses.includes(entry.status)) endpoint.statuses.push(entry.status);
        endpoints.set(key, endpoint);
      }

      const gameId = gameIdOf(entry);
      if (!gameId) continue;
      const game = games.get(gameId) ?? newGame(gameId);
      games.set(gameId, game);

      const name = entry.query.gamename?.[0];
      uniqPush(game.names, name);
      const slug = slugOf(entry);
      uniqPush(game.slugs, slug);
      if (slug && buildMatch && slug === buildMatch[1]) uniqPush(game.builds, `build-${buildMatch[2]}`);

      if (!/\/capi\//i.test(entry.path)) {
        if (/papi/i.test(entry.host)) {
          uniqPush(game.papi.hosts, entry.host);
          const op = opOf(entry) ?? "unknown";
          game.papi.ops[op] = (game.papi.ops[op] ?? 0) + 1;
          if (game.papi.entries.length < maxPapiEntries) {
            game.papi.entries.push({
              path: entry.path,
              status: entry.status,
              bytes: entry.responseBodyRaw?.length ?? 0,
              snippet: snippet(decodeBody(entry.responseBodyRaw, entry.responseEncoding)),
            });
          }
        }
        continue;
      }

      const op = opOf(entry) ?? "unknown";
      game.ops[op] = (game.ops[op] ?? 0) + 1;
      uniqPush(game.transport.baseUrls, `${new URL(entry.url).origin}/capi/${gameId}/play`);
      uniqPush(game.transport.ops, op);

      const attrs = requestAttrs(decodeBody(entry.requestBodyRaw, entry.requestEncoding));
      let parsed: XmlNode | null = null;
      try {
        const body = decodeBody(entry.responseBodyRaw, entry.responseEncoding);
        parsed = body ? parseXml(body) : null;
      } catch {
        parsed = null;
      }
      const errorcode = parsed
        ? Number(xmlText(((parsed.response ?? parsed) as XmlNode).errorcode) ?? 0)
        : null;

      if (op === "init") {
        uniqPush(game.operatorIds, attrs?.opid ?? null);
        for (const header of entry.requestHeaders) {
          const name = header.name.toLowerCase();
          if (name === "x-client-version" || name === "x-ecf-version" || name === "x-capi-version") {
            game.transport.headers[header.name] = header.value;
          }
        }
        if (parsed) {
          try {
            const info = parseInit(parsed);
            if (!game.initInfo && info.betlevels.length > 0) {
              game.initInfo = info;
              game.bets = info.betlevels.map((level) => ({
                betlevel: level.id,
                bmodes: Object.fromEntries(level.bmodes.map((bmode) => [bmode.id, bmode.amount])),
              }));
            }
          } catch {
            notes.push(`${gameId}: init no parseable`);
          }
        }
        rememberSample(game, "init", entry, redact, maxChars);
      } else if (op === "purchase" || op === "claim") {
        uniqPush(game.variants, attrs?.variant ?? null);
        if (parsed) {
          try {
            const purchase = parsePurchase(parsed);
            if (purchase.roundid) {
              game.purchasesByRound.set(purchase.roundid, {
                betamount: purchase.betamount,
                winamount: purchase.winamount,
                balanceAfterPurchase: purchase.balanceAfterPurchase,
                bmode: purchase.bmode,
              });
              game.rounds.push({
                roundid: purchase.roundid,
                betlevel: purchase.betlevel,
                bmode: purchase.bmode,
                betamount: purchase.betamount,
                winamount: purchase.winamount,
                balanceAfterPurchase: purchase.balanceAfterPurchase,
                balanceAfterCheckwin: null,
                balanceExpectedAfterWin: null,
                balanced: null,
                seed: purchase.pubdata?.seed ?? null,
                revision: purchase.pubdata?.revision ?? null,
                results: purchase.pubdata?.results.length ?? 0,
                modes: purchase.pubdata?.modes ?? [],
                actions: purchase.pubdata?.actions ?? [],
                variant: attrs?.variant ?? null,
              });
              uniqPush(game.revisions, purchase.pubdata?.revision ?? null);
            }
          } catch {
            notes.push(`${gameId}: ${op} no parseable`);
          }
        }
        rememberSample(game, op, entry, redact, maxChars);
      } else if (op === "checkwin") {
        const roundid = attrs?.roundid ?? "";
        if (parsed && roundid) {
          try {
            const balance = parseBalance(parsed);
            game.checkwins.set(roundid, balance.balance);
            const round = game.rounds.find((item) => item.roundid === roundid);
            if (round) round.balanceAfterCheckwin = balance.balance;
          } catch {
            notes.push(`${gameId}: checkwin no parseable`);
          }
        }
        rememberSample(game, "checkwin", entry, redact, maxChars);
      } else if (op === "reject") {
        rememberSample(game, "reject", entry, redact, maxChars);
      } else if (op === "sessionupdate" || op === "replay" || op === "fetchbalance" || op === "saveround") {
        rememberSample(game, op, entry, redact, maxChars);
      }

      if (errorcode != null && errorcode !== 0) {
        notes.push(`${gameId}: ${op} errorcode=${errorcode}`);
      }
    }
  }

  // Un mismo HAR puede repetir la sesion (o dos HAR solaparse): dedupe por
  // roundid conservando la informacion de checkwin si aparece en otro archivo.
  for (const game of games.values()) {
    const byRound = new Map<string, HarElkRound>();
    for (const round of game.rounds) {
      const existing = byRound.get(round.roundid);
      if (!existing) {
        byRound.set(round.roundid, round);
        continue;
      }
      if (existing.balanceAfterCheckwin == null && round.balanceAfterCheckwin != null) {
        existing.balanceAfterCheckwin = round.balanceAfterCheckwin;
      }
      if (!existing.seed && round.seed) existing.seed = round.seed;
    }
    game.rounds = [...byRound.values()];

    for (const build of builds.values()) {
      if (game.names.includes(build.bundle)) {
        uniqPush(game.slugs, build.bundle);
        uniqPush(game.builds, `build-${build.build}`);
      }
    }
  }

  const finalized = [...games.values()].map(finalize).sort((a, b) => a.gameId.localeCompare(b.gameId));
  for (const game of finalized) {
    if (!game.declared) game.notes.push("sin init exitoso: no hay betlevels ni RTP declarados");
    if ((game.ops.purchase ?? 0) === 0) game.notes.push("sin purchase: giro no verificado");
    if (game.balanceAudit.checked === 0) game.notes.push("sin checkwin emparejado: contabilidad no auditada");
    if (game.balanceAudit.failures.length) {
      game.notes.push(`${game.balanceAudit.failures.length} ronda(s) con saldo inconsistente`);
    }
  }

  return {
    schema: "deep-slots/har-elk/v1",
    files: hars.map((har) => ({
      path: har.path,
      sizeMB: Number((har.sizeBytes / 1024 / 1024).toFixed(2)),
      entries: har.entries.length,
      apiEntries: har.entries.filter(isApiEntry).length,
    })),
    generatedAt: new Date().toISOString(),
    games: finalized,
    builds: [...builds.values()].sort((a, b) => b.count - a.count),
    apiEndpoints: [...endpoints.values()].sort((a, b) => b.count - a.count),
    notes: [...new Set(notes)].slice(0, 100),
  };
}

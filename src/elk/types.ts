import { isNode, listOf, parseXml, xmlAttr, xmlBool, xmlNumber, xmlText, type XmlNode } from "./xml.js";

export type ElkBmode = {
  id: string;
  amount: number;
  maxwinamount: number | null;
  coinvalue: number | null;
  autospin: boolean | null;
};

export type ElkBetLevel = {
  id: number;
  bmodes: ElkBmode[];
};

export type ElkBmodeDisplay = {
  id: string;
  display: string;
  /** Multiplicador numerico derivado de `display` ("500x" -> 500). */
  multiplier: number | null;
};

export type ElkInitInfo = {
  gamesession: string;
  currency: string;
  balance: number;
  playerhash: string | null;
  roundid: string;
  servertime: number | null;
  minspindelay: number;
  maxwin: number | null;
  defaultBetLevel: number | null;
  rtp: number | null;
  hf: number | null;
  cpbb: string | null;
  bmodeEnabled: boolean;
  betlevels: ElkBetLevel[];
  bmodes: ElkBmodeDisplay[];
  gameprops: Record<string, string>;
  jurisdiction: string | null;
  features: Record<string, unknown>;
  papi: string | null;
  onetimetoken: boolean;
};

export type ElkPubdataSummary = {
  seed: string | null;
  revision: string | null;
  bmode: string | null;
  betamount: number | null;
  betcoins: number | null;
  win: number | null;
  winamount: number | null;
  purchases: number;
  results: Array<{
    mode: string | null;
    resultIndex: number | null;
    winamount: number | null;
    wintotal: number | null;
  }>;
  actions: string[];
  modes: string[];
};

export type ElkRound = {
  index: number;
  roundid: string;
  betlevel: number;
  bmode: string;
  betamount: number;
  winamount: number;
  balanceBefore: number | null;
  /** Saldo que devolvio `purchase` (normalmente ya debitado). */
  balanceAfterPurchase: number | null;
  /** Saldo declarado en `roundinfo.balanceafterwin`. */
  balanceAfterWin: number | null;
  /** Saldo confirmado por `checkwin`. */
  balanceAfterSettle: number | null;
  settled: boolean;
  /** null = no se pudo validar; true/false = resultado de la comprobacion contable. */
  validated: boolean | null;
  errors: string[];
  pubdata: ElkPubdataSummary | null;
  durationMs: number;
  at: string;
};

export type ElkBalanceValidation = {
  ok: boolean;
  expected: number | null;
  actual: number | null;
  /** Algunos operadores acreditan el premio ya en `purchase`. */
  creditedAtPurchase: boolean;
  errors: string[];
};

function featureEntries(node: unknown): Record<string, unknown> {
  if (!isNode(node)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("@")) continue;
    if (key === "__cdata" || key === "#text") continue;
    out[key] = value;
  }
  return out;
}

export function parseInit(root: XmlNode): ElkInitInfo {
  const body = (root.response ?? root) as XmlNode;
  const session = isNode(body.gamesession) ? body.gamesession : {};
  const player = isNode(body.player) ? body.player : {};
  const betlevelsNode = isNode(body.betlevels) ? body.betlevels : {};
  const gameprops = isNode(body.gameprops) ? body.gameprops : {};
  const jurisdiction = isNode(body.jurisdiction) ? body.jurisdiction : {};

  const betlevels: ElkBetLevel[] = listOf(betlevelsNode.betlevel as XmlNode | XmlNode[] | undefined).map(
    (level) => ({
      id: Number(xmlAttr(level, "id") ?? 0),
      bmodes: listOf((level as XmlNode).bmodes && ((level as XmlNode).bmodes as XmlNode).bmode)
        .map((bmode) => ({
          id: String(xmlAttr(bmode, "id") ?? ""),
          amount: xmlNumber(bmode, "amount") ?? 0,
          maxwinamount: xmlNumber(bmode, "maxwinamount"),
          coinvalue: xmlNumber(bmode, "coinvalue"),
          autospin: xmlBool(bmode, "autospin"),
        }))
        .filter((bmode) => bmode.id !== ""),
    }),
  );

  const bmodes: ElkBmodeDisplay[] = listOf(
    (gameprops.bmodemultipliers as XmlNode | undefined)?.bmode as XmlNode | XmlNode[] | undefined,
  ).map((bmode) => {
    const display = String(xmlAttr(bmode, "display") ?? "");
    const match = /^(\d+(?:[.,]\d+)?)x$/i.exec(display);
    return {
      id: String(xmlAttr(bmode, "id") ?? ""),
      display,
      multiplier: match ? Number(match[1]!.replace(",", ".")) : null,
    };
  });

  return {
    gamesession: String(xmlAttr(session, "id") ?? ""),
    currency: String(xmlText(player.currency) ?? "EUR"),
    balance: Number(xmlText(player.balance) ?? 0),
    playerhash: xmlText(player.playerhash),
    roundid: String(xmlText(body.roundid) ?? "0"),
    servertime: Number(xmlText(body.servertime) ?? 0) || null,
    minspindelay: Number(xmlText(session.minspindelay) ?? 0) || 0,
    maxwin: xmlNumber(betlevelsNode, "maxwin"),
    defaultBetLevel: xmlNumber(betlevelsNode, "default"),
    rtp: xmlNumber(betlevelsNode, "rtp"),
    hf: xmlNumber(betlevelsNode, "hf"),
    cpbb: xmlAttr(betlevelsNode, "cpbb"),
    bmodeEnabled: xmlBool(betlevelsNode, "bmode") ?? false,
    betlevels,
    bmodes,
    gameprops: Object.fromEntries(
      Object.entries(gameprops)
        .filter(([k, v]) => !k.startsWith("@") && k !== "__cdata" && !isNode(v))
        .map(([k, v]) => [k, String(xmlText(v) ?? "")]),
    ),
    jurisdiction: xmlText(jurisdiction.intjur),
    features: featureEntries(jurisdiction.features),
    papi: isNode(body.papi) ? xmlText(body.papi.url) : null,
    onetimetoken: xmlBool(session, "onetimetoken") ?? false,
  };
}

function collectByTag(node: unknown, tag: string, out: XmlNode[] = []): XmlNode[] {
  if (Array.isArray(node)) {
    for (const item of node) collectByTag(item, tag, out);
    return out;
  }
  if (!isNode(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (key === tag) {
      for (const item of listOf(value as XmlNode | XmlNode[])) {
        if (isNode(item)) out.push(item);
      }
    }
    if (isNode(value) || Array.isArray(value)) collectByTag(value, tag, out);
  }
  return out;
}

/** Extrae el resumen replay del CDATA `<PURCHASES>...</PURCHASES>`. */
export function parsePubdata(pubdata: unknown): ElkPubdataSummary | null {
  const text = xmlText(pubdata);
  if (!text || !/[<]PURCHASE/i.test(text)) return null;
  let doc: XmlNode;
  try {
    doc = parseXml(text);
  } catch {
    return null;
  }
  const purchases = collectByTag(doc, "PURCHASE");
  const results = collectByTag(doc, "RESULT").map((result) => ({
    mode: xmlAttr(result, "mode"),
    resultIndex: xmlNumber(result, "resultIndex"),
    winamount: xmlNumber(result, "winamount"),
    wintotal: xmlNumber(result, "wintotal"),
  }));
  const actions = collectByTag(doc, "ACTION")
    .map((action) => xmlAttr(action, "name"))
    .filter((name): name is string => Boolean(name));
  const first = purchases[0] ?? {};
  const modes = [...new Set(results.map((r) => r.mode).filter((m): m is string => Boolean(m)))];

  return {
    seed: xmlAttr(first, "clientseed"),
    revision: xmlAttr(first, "revision"),
    bmode: xmlAttr(first, "bmode"),
    betamount: xmlNumber(first, "betamount"),
    betcoins: xmlNumber(first, "betcoins"),
    win: xmlNumber(first, "win"),
    winamount: xmlNumber(first, "winamount"),
    purchases: purchases.length,
    results,
    actions,
    modes,
  };
}

export type PurchaseInfo = {
  roundid: string;
  betlevel: number;
  betamount: number;
  winamount: number;
  bmode: string;
  balanceAfterPurchase: number;
  balanceAfterWin: number | null;
  pubdata: ElkPubdataSummary | null;
  minspindelay: number;
  gamesession: string;
};

export function parsePurchase(root: XmlNode): PurchaseInfo {
  const body = (root.response ?? root) as XmlNode;
  const session = isNode(body.gamesession) ? body.gamesession : {};
  const player = isNode(body.player) ? body.player : {};
  const roundinfo = isNode(body.roundinfo) ? body.roundinfo : {};
  const game = isNode(body.game) ? body.game : {};

  return {
    roundid: String(xmlText(roundinfo.roundid) ?? xmlText(body.roundid) ?? ""),
    betlevel: Number(xmlText(roundinfo.betlevel) ?? 0),
    betamount: Number(xmlText(roundinfo.betamount) ?? 0),
    winamount: Number(xmlText(roundinfo.winamount) ?? 0),
    bmode: String(xmlText(roundinfo.bmode) ?? "DEF"),
    balanceAfterPurchase: Number(xmlText(player.balance) ?? 0),
    balanceAfterWin: Number(xmlText(roundinfo.balanceafterwin) ?? NaN) || null,
    pubdata: parsePubdata(game.pubdata),
    minspindelay: Number(xmlText(session.minspindelay) ?? 0) || 0,
    gamesession: String(xmlAttr(session, "id") ?? ""),
  };
}

export type BalanceInfo = {
  gamesession: string;
  balance: number;
  roundid: string;
  minspindelay: number;
  currency: string | null;
};

export function parseBalance(root: XmlNode): BalanceInfo {
  const body = (root.response ?? root) as XmlNode;
  const session = isNode(body.gamesession) ? body.gamesession : {};
  const player = isNode(body.player) ? body.player : {};
  return {
    gamesession: String(xmlAttr(session, "id") ?? ""),
    balance: Number(xmlText(player.balance) ?? 0),
    roundid: String(xmlText(body.roundid) ?? "0"),
    minspindelay: Number(xmlText(session.minspindelay) ?? 0) || 0,
    currency: xmlText(player.currency),
  };
}

/** Redondeo monetario tolerante a float (1e-9). */
export function money(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Nombres de features con `<enabled>true</enabled>`. */
export function enabledFeatures(features: Record<string, unknown>): string[] {
  return Object.entries(features)
    .filter(([, value]) => isNode(value) && String(xmlText((value as XmlNode).enabled) ?? "").toLowerCase() === "true")
    .map(([key]) => key)
    .sort();
}

/** Hash estable y corto (FNV-1a) para claves de familia legibles. */
export function shortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, "0").slice(0, 7);
}

export type ElkFamilyInput = {
  rtp: number | null;
  maxwin: number | null;
  betlevels: number;
  bmodes: string[];
  features: Record<string, unknown>;
} | null;

/**
 * Clave de familia del adaptador. Agrupa juegos que comparten contrato de
 * transporte, matriz de apuestas y capacidades: lo que hay que replicar.
 */
export function elkFamilyKey(declared: ElkFamilyInput, variant: string | null | undefined): string {
  if (!declared) return "elk-capi-v2|unknown";
  return [
    "elk-capi-v2",
    `betlevels=${declared.betlevels}`,
    `bmodes=${declared.bmodes.join(",") || "none"}`,
    `rtp=${declared.rtp ?? "?"}`,
    `maxwin=${declared.maxwin ?? "?"}`,
    `features=${shortHash(enabledFeatures(declared.features).join(","))}`,
    `variant=${variant ?? "default"}`,
  ].join("|");
}

export function validateBalance(
  before: number | null,
  bet: number,
  win: number,
  afterPurchase: number | null,
  afterSettle: number | null,
): ElkBalanceValidation {
  if (before == null || afterPurchase == null) {
    return {
      ok: true,
      expected: null,
      actual: null,
      creditedAtPurchase: false,
      errors: ["sin saldo previo: no se pudo validar"],
    };
  }
  const expectedDebit = money(before - bet);
  const expectedFinal = money(before - bet + win);
  const errors: string[] = [];
  const creditedAtPurchase =
    win > 0 &&
    Math.abs(afterPurchase - expectedFinal) <= 0.005 &&
    Math.abs(afterPurchase - expectedDebit) > 0.005;

  if (!creditedAtPurchase && Math.abs(afterPurchase - expectedDebit) > 0.005) {
    errors.push(
      `purchase: saldo ${afterPurchase.toFixed(2)} != esperado ${expectedDebit.toFixed(2)} (debito ${bet.toFixed(2)})`,
    );
  }
  const final = afterSettle ?? afterPurchase;
  if (Math.abs(final - expectedFinal) > 0.005) {
    errors.push(
      `${afterSettle == null ? "purchase" : "checkwin"}: saldo ${final.toFixed(2)} != esperado ${expectedFinal.toFixed(2)} (apuesta ${bet.toFixed(2)} + premio ${win.toFixed(2)})`,
    );
  }
  return { ok: errors.length === 0, expected: expectedFinal, actual: final, creditedAtPurchase, errors };
}

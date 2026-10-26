import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Selectors = {
  /** Boton de giro. Si se omite se busca por rol/nombre accesible. */
  spin?: string;
  betIncrease?: string;
  betDecrease?: string;
  /** Elemento cuyo texto es la apuesta actual (ej. "1,00"). */
  bet?: string;
  /** Elemento cuyo texto es el saldo. */
  balance?: string;
  /** Elemento cuyo texto es la ganancia del ultimo giro. */
  win?: string;
  /** Selector del canvas del juego (para screenshots del rodillo). */
  canvas?: string;
};

export type SlotsConfig = {
  url: string;
  browser: {
    /** "msedge" | "chrome" usan el navegador instalado. null = chromium de Playwright. */
    channel: "msedge" | "chrome" | null;
    headless: boolean;
    viewport: { width: number; height: number };
    locale: string;
  };
  selectors: Selectors;
  labels: {
    spin: string[];
    betIncrease: string[];
    betDecrease: string[];
    /** Textos de botones que confirman una accion (compras de bonus, modales, age gates). */
    confirm: string[];
  };
  network: {
    /** Regex sobre la URL de la respuesta que representa un giro. Ej: "/spin|/play|/round" */
    spinEndpoint?: string;
  };
  spin: {
    settleMs: number;
    timeoutMs: number;
    waitForNetwork: boolean;
  };
  elk: {
    /** Host del capi; el cliente compone /capi/{gameId}/{mode}. */
    origin: string;
    operatorId: string;
    currency: string;
    locale: string;
    /** gameId por defecto para `elk_init` sin argumentos. */
    gameId: string;
    timeoutMs: number;
    retries: number;
    /** Cabeceras que Elk exige; el valor por defecto es aceptado por cualquier juego. */
    clientVersion: string;
    ecfVersion: string;
  };
  artifactsDir: string;
};

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "..");

export const configPath = process.env.SLOTS_CONFIG
  ? path.resolve(process.env.SLOTS_CONFIG)
  : path.join(projectRoot, "slots.config.json");

export const defaults: SlotsConfig = {
  url: "",
  browser: {
    channel: null,
    headless: false,
    viewport: { width: 1440, height: 900 },
    locale: "es-ES",
  },
  selectors: {},
  labels: {
    spin: ["spin", "girar", "jugar", "play", "start", "tirar"],
    betIncrease: [
      "+",
      "increase bet",
      "subir apuesta",
      "aumentar apuesta",
      "max bet",
      "apuesta max",
    ],
    betDecrease: ["-", "decrease bet", "bajar apuesta", "disminuir apuesta"],
    confirm: [
      "confirmar",
      "confirm",
      "comprar",
      "buy",
      "aceptar",
      "ok",
      "sí",
      "si",
      "yes",
      "continuar",
      "continue",
      "pagar",
      "pay",
    ],
  },
  network: {},
  spin: { settleMs: 1200, timeoutMs: 15000, waitForNetwork: true },
  elk: {
    origin: "https://gc5-stage.contentmedia.eu",
    operatorId: "44",
    currency: "EUR",
    locale: "en_gb",
    gameId: "",
    timeoutMs: 20000,
    retries: 2,
    clientVersion: "263580",
    ecfVersion: "369146",
  },
  artifactsDir: ".slots-artifacts",
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function merge<T>(base: T, extra: unknown): T {
  if (!isObject(base) || !isObject(extra)) {
    return (extra === undefined ? base : (extra as T));
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) continue;
    out[k] = isObject(out[k]) && isObject(v) ? merge(out[k], v) : v;
  }
  return out as T;
}

let cached: { mtimeMs: number; config: SlotsConfig } | null = null;

/** Recarga el JSON si cambio en disco, para no reiniciar el MCP al calibrar selectores. */
export function loadConfig(): SlotsConfig {
  let fileCfg: unknown = {};
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(configPath);
    mtimeMs = stat.mtimeMs;
    if (!cached || cached.mtimeMs !== mtimeMs) {
      fileCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } else {
      return cached.config;
    }
  } catch {
    fileCfg = {};
  }

  const config = merge(defaults, fileCfg);
  if (process.env.SLOTS_URL) config.url = process.env.SLOTS_URL;
  if (process.env.SLOTS_HEADLESS) {
    config.browser.headless = process.env.SLOTS_HEADLESS !== "0";
  }
  if (process.env.SLOTS_CHANNEL) {
    config.browser.channel = process.env.SLOTS_CHANNEL as SlotsConfig["browser"]["channel"];
  }
  if (process.env.ELK_ORIGIN) config.elk.origin = process.env.ELK_ORIGIN;
  if (process.env.ELK_GAME_ID) config.elk.gameId = process.env.ELK_GAME_ID;
  if (process.env.ELK_OPERATOR_ID) config.elk.operatorId = process.env.ELK_OPERATOR_ID;
  if (process.env.ELK_CURRENCY) config.elk.currency = process.env.ELK_CURRENCY;
  if (process.env.ELK_CLIENT_VERSION) config.elk.clientVersion = process.env.ELK_CLIENT_VERSION;
  if (process.env.ELK_ECF_VERSION) config.elk.ecfVersion = process.env.ELK_ECF_VERSION;
  config.artifactsDir = path.isAbsolute(config.artifactsDir)
    ? config.artifactsDir
    : path.join(projectRoot, config.artifactsDir);

  cached = { mtimeMs, config };
  return config;
}

export function writeConfigPatch(patch: unknown): SlotsConfig {
  const current = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {};
  const next = merge(current, patch);
  fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + "\n", "utf8");
  cached = null;
  return loadConfig();
}

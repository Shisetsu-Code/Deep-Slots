import { buildRequest, parseXml, xmlAttr, xmlText, type RequestAttrs, type XmlNode } from "./xml.js";

export type ElkMode = "play" | "real" | "replay";

export type ElkClientOptions = {
  /** Base completa, ej. `https://gc5-stage.contentmedia.eu/capi/10222/play`. */
  baseUrl?: string;
  /** Host del capi, ej. `https://gc5-stage.contentmedia.eu`. */
  origin?: string;
  gameId?: string | number;
  operatorId?: string;
  mode?: ElkMode;
  currency?: string;
  locale?: string;
  /** `screenres` que declara el cliente. */
  screenres?: string;
  /** `X-CLIENT-VERSION`: build del juego (game.js). Elk exige la cabecera, no un valor exacto. */
  clientVersion?: string;
  /** `X-ECF-VERSION`: build del shell ecf3. */
  ecfVersion?: string;
  /** Cabeceras extra (se mezclan con las de Elk). */
  headers?: Record<string, string>;
  /** Parametros de query que se agregan a todas las ops (Elk los usa en `init`). */
  query?: Record<string, string>;
  /** Solo para `init`; por defecto `gl=true&standalone=false&iframe=true`. */
  initQuery?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  /** `Origin`/`Referer` del iframe. Si se omite se deduce del host stage. */
  originHeader?: string;
};

export type ElkCallRecord = {
  id: number;
  op: string;
  url: string;
  status: number;
  ms: number;
  errorcode: number | null;
  method: string | null;
  error: string | null;
  attempts: number;
  request: string;
  response: string;
  at: string;
};

export type ElkCallResult = {
  op: string;
  url: string;
  status: number;
  ms: number;
  errorcode: number;
  method: string | null;
  error: string | null;
  request: string;
  response: string;
  parsed: XmlNode;
  /** Cuerpo del nodo `<response>` ya desempaquetado. */
  body: XmlNode;
  attempts: number;
};

export class ElkError extends Error {
  readonly code: number;
  readonly op: string;
  readonly method: string | null;
  readonly response: string;

  constructor(op: string, code: number, message: string, method: string | null, response: string) {
    super(`[elk ${op}] errorcode=${code}${message ? `: ${message}` : ""}`);
    this.name = "ElkError";
    this.code = code;
    this.op = op;
    this.method = method;
    this.response = response;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * `purchase` y `claim` no son idempotentes: reintentar un 5xx puede abrir dos
 * rondas o cobrar dos veces. Solo se reintentan las ops de lectura.
 */
const NON_IDEMPOTENT = new Set(["purchase", "claim", "reject", "saveround"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deriveOriginHeader(host: string): string | undefined {
  try {
    const url = new URL(host);
    if (url.host.includes("-stage.")) return `https://static-stage.contentmedia.eu`;
    return undefined;
  } catch {
    return undefined;
  }
}

export class ElkCapi {
  readonly opts: Required<Pick<ElkClientOptions, "mode" | "currency" | "locale" | "timeoutMs" | "retries">> &
    ElkClientOptions;
  readonly baseUrl: string;
  readonly calls: ElkCallRecord[] = [];
  private nextId = 1;

  constructor(options: ElkClientOptions) {
    const mode = options.mode ?? "play";
    const baseUrl =
      options.baseUrl ??
      (options.origin && options.gameId != null
        ? `${options.origin.replace(/\/+$/, "")}/capi/${options.gameId}/${mode}`
        : undefined);
    if (!baseUrl) {
      throw new Error("ElkCapi requiere baseUrl o (origin + gameId)");
    }
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.opts = {
      ...options,
      mode,
      currency: options.currency ?? "EUR",
      locale: options.locale ?? "en_gb",
      timeoutMs: options.timeoutMs ?? 20_000,
      retries: options.retries ?? 2,
    };
  }

  get gameId(): string | null {
    const match = /\/capi\/([^/]+)\//.exec(this.baseUrl);
    return match ? match[1]! : null;
  }

  private urlFor(op: string, extra?: Record<string, string>): string {
    const url = new URL(`${this.baseUrl}/${op}`);
    for (const [key, value] of Object.entries({ ...(this.opts.query ?? {}), ...(extra ?? {}) })) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private headers(): Record<string, string> {
    const origin = this.opts.originHeader ?? deriveOriginHeader(this.baseUrl);
    return {
      accept: "*/*",
      "accept-language": "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",
      "content-type": "text/xml; charset=utf-8",
      "x-capi-version": "2.0",
      "x-capi-rid": `${Date.now()}${Math.floor(Math.random() * 100)}:1`,
      "x-client-version": this.opts.clientVersion ?? "263580",
      "x-ecf-version": this.opts.ecfVersion ?? "369146",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      ...(origin ? { origin, referer: `${origin}/` } : {}),
      ...(this.opts.headers ?? {}),
    };
  }

  /**
   * Ejecuta una op del capi. Reintenta solo fallos de transporte/5xx; un
   * `errorcode` de aplicacion se devuelve tal cual para que la sesion decida.
   */
  async call(
    op: string,
    attrs: RequestAttrs = {},
    options: { query?: Record<string, string>; tolerate?: number[]; throwOnError?: boolean; retry?: boolean } = {},
  ): Promise<ElkCallResult> {
    const request = buildRequest(attrs);
    const url = this.urlFor(op, options.query);
    const started = Date.now();
    const retryAllowed = options.retry ?? !NON_IDEMPOTENT.has(op);
    let attempts = 0;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= this.opts.retries; attempt++) {
      attempts++;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: this.headers(),
          body: request,
          signal: AbortSignal.timeout(this.opts.timeoutMs),
        });
        const text = await response.text();
        if (retryAllowed && !response.ok && RETRYABLE_STATUS.has(response.status) && attempt < this.opts.retries) {
          await sleep(250 * (attempt + 1));
          continue;
        }

        let parsed: XmlNode;
        try {
          parsed = parseXml(text);
        } catch (err) {
          const record = this.record(op, url, response.status, Date.now() - started, null, null, "XML invalido", attempts, request, text);
          if (!response.ok) {
            throw new Error(`[elk ${op}] HTTP ${response.status} (${record.ms} ms): ${text.slice(0, 300)}`);
          }
          throw new Error(`[elk ${op}] XML invalido: ${(err as Error).message}. Body: ${text.slice(0, 200)}`);
        }

        const body = (parsed.response ?? parsed) as XmlNode;
        const errorcode = Number(xmlText(body.errorcode) ?? 0) || 0;
        const method = xmlText(body.method);
        const errorMessage = xmlText(body.errormessage) ?? xmlText(body.message) ?? "";
        const record = this.record(
          op,
          url,
          response.status,
          Date.now() - started,
          errorcode,
          method,
          errorcode === 0 ? (response.ok ? null : `HTTP ${response.status}`) : errorMessage || `errorcode ${errorcode}`,
          attempts,
          request,
          text,
        );

        const result: ElkCallResult = {
          op,
          url,
          status: response.status,
          ms: record.ms,
          errorcode,
          method,
          error: record.error,
          request,
          response: text,
          parsed,
          body,
          attempts,
        };

        if (!response.ok && errorcode === 0) {
          throw new Error(`[elk ${op}] HTTP ${response.status} con errorcode=0: ${text.slice(0, 300)}`);
        }
        if (errorcode !== 0 && options.throwOnError !== false && !(options.tolerate ?? []).includes(errorcode)) {
          throw new ElkError(op, errorcode, errorMessage, method, text);
        }
        return result;
      } catch (err) {
        lastError = err;
        if (err instanceof ElkError) throw err;
        const retryable = retryAllowed && !/HTTP 4\d\d/.test(String((err as Error)?.message ?? ""));
        if (attempt < this.opts.retries && retryable) {
          await sleep(300 * (attempt + 1));
          continue;
        }
        if (err instanceof Error && err.message.startsWith("[elk")) throw err;
        throw new Error(`[elk ${op}] ${(err as Error)?.message ?? String(err)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`[elk ${op}] fallo desconocido`);
  }

  private record(
    op: string,
    url: string,
    status: number,
    ms: number,
    errorcode: number | null,
    method: string | null,
    error: string | null,
    attempts: number,
    request: string,
    response: string,
  ): ElkCallRecord {
    const record: ElkCallRecord = {
      id: this.nextId++,
      op,
      url,
      status,
      ms,
      errorcode,
      method,
      error,
      attempts,
      request: request.slice(0, 200_000),
      response: response.slice(0, 400_000),
      at: new Date().toISOString(),
    };
    this.calls.push(record);
    if (this.calls.length > 500) this.calls.shift();
    return record;
  }

  // ------------------------------------------------------------ operaciones

  init(overrides: RequestAttrs = {}): Promise<ElkCallResult> {
    const attrs: RequestAttrs = {
      opid: this.opts.operatorId ?? "44",
      extsession: String(Date.now()),
      cur: this.opts.currency,
      desktopmode: true,
      lang: this.opts.locale,
      screenres: this.opts.screenres ?? "1920,1080,1718,966",
      extjur: "NA",
      ...overrides,
    };
    return this.call("init", attrs, {
      query: this.opts.initQuery ?? { gl: "true", standalone: "false", iframe: "true" },
    });
  }

  purchase(
    opts: {
      gamesession: string;
      amount: number;
      betlevel: number;
      bmode?: string;
      betdetails?: string;
      pmode?: string;
      orientation?: string;
      sound?: string;
      monetaryunit?: string;
      gamespeed?: string;
      variant?: string;
      viewdata?: string;
      rcm?: string;
      extra?: RequestAttrs;
    },
  ): Promise<ElkCallResult> {
    return this.call("purchase", this.purchaseAttrs(opts), { throwOnError: false });
  }

  claim(
    opts: {
      gamesession: string;
      amount: number;
      betlevel: number;
      bmode: string;
      betdetails?: string;
      pmode?: string;
      orientation?: string;
      sound?: string;
      monetaryunit?: string;
      gamespeed?: string;
      variant?: string;
      viewdata?: string;
    },
  ): Promise<ElkCallResult> {
    return this.call("claim", this.purchaseAttrs({ ...opts, bmode: opts.bmode }), { throwOnError: false });
  }

  reject(gamesession: string, temporary: boolean | string = true): Promise<ElkCallResult> {
    return this.call("reject", { gamesession, temporary: String(temporary) }, { throwOnError: false });
  }

  checkwin(gamesession: string, roundid?: string | number): Promise<ElkCallResult> {
    const attrs: RequestAttrs =
      roundid != null && String(roundid) !== "0" && String(roundid) !== ""
        ? { roundid: String(roundid), gamesession }
        : { gamesession };
    return this.call("checkwin", attrs, { throwOnError: false });
  }

  sessionupdate(gamesession: string): Promise<ElkCallResult> {
    return this.call("sessionupdate", { gamesession }, { throwOnError: false });
  }

  replay(gamesession: string, roundid: string | number): Promise<ElkCallResult> {
    return this.call("replay", { gamesession, roundid: String(roundid) }, { throwOnError: false });
  }

  fetchbalance(gamesession: string): Promise<ElkCallResult> {
    return this.call("fetchbalance", { gamesession }, { throwOnError: false });
  }

  saveround(gamesession: string, roundid: string | number): Promise<ElkCallResult> {
    return this.call("saveround", { gamesession, roundid: String(roundid) }, { throwOnError: false });
  }

  private purchaseAttrs(opts: {
    gamesession: string;
    amount: number;
    betlevel: number;
    bmode?: string;
    betdetails?: string;
    pmode?: string;
    orientation?: string;
    sound?: string;
    monetaryunit?: string;
    gamespeed?: string;
    variant?: string;
    viewdata?: string;
    rcm?: string;
    extra?: RequestAttrs;
  }): RequestAttrs {
    const attrs: RequestAttrs = {
      gamesession: opts.gamesession,
      amount: opts.amount.toFixed(2),
      cur: this.opts.currency,
    };
    if (opts.bmode) attrs.bmode = opts.bmode;
    attrs.betdetails = opts.betdetails ?? "";
    attrs.betlevel = opts.betlevel;
    if (opts.viewdata) attrs.viewdata = opts.viewdata;
    attrs.pmode = opts.pmode ?? "click-s0";
    attrs.orientation = opts.orientation ?? "landscape";
    attrs.sound = opts.sound ?? "bgeffect";
    attrs.monetaryunit = opts.monetaryunit ?? "money";
    attrs.gamespeed = opts.gamespeed ?? "normal";
    if (opts.variant) attrs.variant = opts.variant;
    if (opts.rcm) attrs.rcm = opts.rcm;
    return { ...attrs, ...(opts.extra ?? {}) };
  }
}

/** Oculta el identificador de sesion en textos antes de devolverlos. */
export function maskId(value: string): string {
  if (value.length <= 10) return value;
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function redactSession(text: string): string {
  return text
    .replace(/(gamesession=")([^"]+)(")/gi, (_m, a: string, v: string, c: string) => `${a}${maskId(v)}${c}`)
    .replace(/(<gamesession>\s*<id>)([^<]+)(<\/id>)/gi, (_m, a: string, v: string, c: string) => `${a}${maskId(v)}${c}`)
    .replace(/(<playerhash>)([^<]+)(<\/playerhash>)/gi, "$1<redacted>$3");
}

export { xmlAttr };

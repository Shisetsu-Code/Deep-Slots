import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type Frame,
  type Locator,
  type Page,
  type Request,
  type Response,
} from "playwright-core";
import { loadConfig, type SlotsConfig } from "./config.js";
import {
  artifactPath,
  ensureDir,
  extractMoneyFields,
  parseAmount,
  safeJsonParse,
  truncate,
} from "./util.js";

export type MapEntry = {
  /** Numero que aparece en el overlay de la captura. */
  n: number;
  /** Identificador estable para slots_click_id. */
  id: string;
  /** Otros nombres aceptados por slots_click_id (slug del texto, texto original...). */
  aliases: string[];
  label: string;
  tag: string;
  role?: string;
  testid?: string;
  cursor: string;
  x: number;
  y: number;
  w: number;
  h: number;
  frameUrl: string;
  /** Ruta del nodo en el arbol del motor (solo mapa canvas). */
  path?: string;
};

export type ConsoleEntry = {
  id: number;
  t: string;
  level: string;
  text: string;
  location?: string;
};

export type NetEntry = {
  id: number;
  t: string;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  resourceType: string;
  ms: number | null;
  failed?: string;
  /** Tamano del cuerpo enviado (bytes) si lo hubo. */
  reqBytes?: number;
  /** Content-Type del request. */
  reqType?: string;
  /** Tamano del cuerpo de respuesta (bytes) cuando se pudo leer. */
  resBytes?: number;
  /** Content-Type de la respuesta. */
  resType?: string;
};

/** Cuerpo HTTP normalizado: texto, JSON o binario (base64/hex). */
export type BodyView = {
  side: "request" | "response";
  bytes: number;
  contentType: string | null;
  kind: "json" | "text" | "binary" | "empty";
  text?: string;
  json?: unknown;
  /** Base64 completo (o recortado si supera maxBytes). */
  base64?: string;
  /** Prefijo en hex (hasta 256 bytes). */
  hex?: string;
  truncated: boolean;
  note?: string;
};

/** Foto del estado del motor de juego (Cocos/Phaser/DOM) sin depender del canvas pintado. */
export type EngineProbe = {
  engine: string;
  version: string | null;
  canvas: { x: number; y: number; w: number; h: number; count: number } | null;
  design: { width: number; height: number } | null;
  scale: number | null;
  resolutionPolicy: string | null;
  state: {
    balance: number | null;
    targetBalance: number | null;
    win: number | null;
    bet: number | null;
    source: string | null;
  } | null;
  fields: Array<{ node: string; comp: string; values: Record<string, number | string | boolean> }>;
  labels: Record<string, string>;
  scene: string[] | null;
  globals: string[];
  sceneNodes: number;
  warning: string | null;
};

/** Nodo clickeable descubierto en el arbol del motor (coordenadas de viewport). */
export type CanvasHit = {
  name: string;
  path: string;
  comps: string[];
  /** Texto del cc.Label del nodo, si lo tiene. */
  text?: string;
  cx: number;
  cy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  interactive: boolean;
};

export type SlotState = {
  url: string | null;
  title: string | null;
  frameUrl: string | null;
  balance: FieldValue;
  bet: FieldValue;
  win: FieldValue;
};

export type FieldValue = {
  value: number | null;
  raw: string | null;
  source: string | null;
};

export type ClickParams = {
  selector?: string;
  role?: "button" | "link" | "slider" | "spinbutton" | "textbox" | "img" | "radio" | "checkbox";
  name?: string;
  text?: string;
  exact?: boolean;
  timeoutMs?: number;
  frameUrlIncludes?: string;
};

const EMPTY_FIELD: FieldValue = { value: null, raw: null, source: null };

export class Session {
  browser: Browser | null = null;
  context: BrowserContext | null = null;
  page: Page | null = null;
  attachedViaCdp = false;

  consoleEntries: ConsoleEntry[] = [];
  netEntries: NetEntry[] = [];
  private responses = new Map<number, Response>();
  private reqStart = new WeakMap<Request, number>();
  private reqBodyByReq = new WeakMap<Request, Buffer>();
  /** Cuerpos por id de NetEntry, en crudo (sin perdida para binarios). */
  private reqBodies = new Map<number, { buf: Buffer; contentType: string | null }>();
  private resBodies = new Map<number, { buf: Buffer; contentType: string | null }>();
  private bodyBytes = 0;
  private seq = 0;
  private chain: Promise<unknown> = Promise.resolve();
  tracing = false;

  /** Serializa acciones que no deben solaparse (spin, run_session). */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  ensurePage(): Page {
    if (!this.page || this.page.isClosed()) {
      throw new Error(
        "No hay navegador abierto. Llama primero a slots_open (o slots_open con cdpUrl para engancharte a un Chrome ya abierto).",
      );
    }
    return this.page;
  }

  frames(): Frame[] {
    return this.page ? this.page.frames() : [];
  }

  /** Origenes de la pagina y sus iframes: sirven para validar coordenadas guardadas. */
  private pageOrigins(): Set<string> {
    const out = new Set<string>();
    for (const frame of this.frames()) {
      try {
        const url = frame.url();
        if (url && url !== "about:blank") out.add(new URL(url).origin);
      } catch {
        /* frame sin URL valida */
      }
    }
    return out;
  }

  async open(opts: {
    url?: string;
    headless?: boolean;
    cdpUrl?: string;
    channel?: "msedge" | "chrome" | null;
    viewport?: { width: number; height: number };
  }): Promise<{ url: string | null; title: string | null; reused: boolean }> {
    const cfg = loadConfig();
    const targetUrl = opts.url ?? cfg.url;

    if (opts.cdpUrl) {
      if (this.page && !this.page.isClosed()) {
        return { url: this.page.url(), title: await this.page.title().catch(() => null), reused: true };
      }
      this.browser = await chromium.connectOverCDP(opts.cdpUrl);
      this.attachedViaCdp = true;
      const ctx = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.context = ctx;
      const existing = ctx.pages();
      const page = existing.find((p) => !p.isClosed()) ?? (await ctx.newPage());
      this.attach(page);
      if (targetUrl && page.url() === "about:blank") {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      }
      await page.waitForTimeout(500);
      return { url: page.url(), title: await page.title().catch(() => null), reused: existing.length > 0 };
    }

    if (this.page && !this.page.isClosed()) {
      let navigated = false;
      if (targetUrl && this.page.url() !== targetUrl) {
        await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        navigated = true;
      }
      return {
        url: this.page.url(),
        title: await this.page.title().catch(() => null),
        reused: !navigated,
      };
    }

    const headless = opts.headless ?? cfg.browser.headless;
    const viewport = opts.viewport ?? cfg.browser.viewport;
    const preferred = opts.channel !== undefined ? opts.channel : cfg.browser.channel;
    const channels: Array<"msedge" | "chrome" | null> = preferred
      ? [preferred]
      : ["msedge", "chrome", null];

    let lastErr: unknown = null;
    for (const channel of channels) {
      try {
        this.browser = await chromium.launch({
          channel: channel ?? undefined,
          headless,
          args: ["--disable-blink-features=AutomationControlled"],
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!this.browser) {
      throw new Error(
        `No pude lanzar un navegador. Detalle: ${String(lastErr)}\n` +
          "Instala Chromium con: npx playwright install chromium  (o define browser.channel en slots.config.json).",
      );
    }

    this.context = await this.browser.newContext({
      viewport,
      locale: cfg.browser.locale,
    });
    this.page = await this.context.newPage();
    this.attach(this.page);

    if (targetUrl) {
      await this.page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    }
    await this.page.waitForTimeout(500);
    return {
      url: this.page.url(),
      title: await this.page.title().catch(() => null),
      reused: false,
    };
  }

  private attach(page: Page): void {
    this.page = page;
    const ctx = page.context();

    const push = (level: string, text: string, location?: string) => {
      this.consoleEntries.push({
        id: ++this.seq,
        t: new Date().toISOString(),
        level,
        text: truncate(text, 8000),
        location,
      });
      if (this.consoleEntries.length > 3000) this.consoleEntries.splice(0, 1000);
    };

    page.on("console", (msg: ConsoleMessage) => {
      const loc = msg.location();
      push(
        msg.type(),
        msg.text(),
        loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}:${loc.columnNumber ?? 0}` : undefined,
      );
    });
    page.on("pageerror", (err: Error) => push("pageerror", err.stack ?? err.message));
    page.on("crash", () => push("crash", "La pagina se ha colgado (renderer crash)"));

    page.on("request", (req: Request) => {
      this.reqStart.set(req, Date.now());
      this.cacheRequestBody(req);
    });

    ctx.on("response", (res: Response) => {
      void this.recordResponse(res);
    });

    ctx.on("requestfailed", (req: Request) => {
      if (!/^https?:/i.test(req.url())) return;
      const started = this.reqStart.get(req);
      this.pushNet({
        id: ++this.seq,
        t: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        status: null,
        ok: false,
        resourceType: req.resourceType(),
        ms: started ? Date.now() - started : null,
        failed: req.failure()?.errorText ?? "failed",
      });
    });
  }

  /** Guarda el cuerpo crudo del request (form, JSON o binario) sin perder bytes. */
  private cacheRequestBody(req: Request): void {
    if (!/^https?:/i.test(req.url())) return;
    try {
      const buf = req.postDataBuffer();
      if (!buf?.length) return;
      this.reqBodyByReq.set(req, buf);
    } catch {
      /* postData no legible en algunos requests */
    }
  }

  /** Lee y guarda el cuerpo de la respuesta en crudo; asi los binarios no se corrompen. */
  private async cacheResponseBody(id: number, res: Response): Promise<void> {
    const type = res.request().resourceType();
    if (!["xhr", "fetch", "document"].includes(type)) return;
    try {
      const len = Number(res.headers()["content-length"] ?? 0);
      if (len > 4_000_000) return;
      const buf = await res.body();
      if (!buf.length) return;
      const contentType = res.headers()["content-type"] ?? null;
      this.storeBody(this.resBodies, id, { buf, contentType });
    } catch {
      /* body no disponible (redirect, navegacion, stream) */
    }
  }

  /** Guarda con tope de memoria: al pasar de 48 MB se descartan los cuerpos mas antiguos. */
  private storeBody(
    store: Map<number, { buf: Buffer; contentType: string | null }>,
    id: number,
    value: { buf: Buffer; contentType: string | null },
  ): void {
    store.set(id, value);
    this.bodyBytes += value.buf.length;
    const maxBytes = 48 * 1024 * 1024;
    while (this.bodyBytes > maxBytes) {
      const oldest = store.keys().next();
      if (oldest.done) break;
      const victim = store.get(oldest.value);
      if (victim) this.bodyBytes -= victim.buf.length;
      store.delete(oldest.value);
      if (oldest.value === id) break;
    }
  }

  private async recordResponse(res: Response): Promise<void> {
    const req = res.request();
    if (!/^https?:/i.test(res.url())) return;
    const started = this.reqStart.get(req);
    const id = ++this.seq;
    let ms: number | null = started ? Date.now() - started : null;
    try {
      const timing = req.timing();
      if (ms == null && timing.responseEnd >= 0) ms = Math.round(timing.responseEnd);
    } catch {
      /* ignore */
    }
    const entry: NetEntry = {
      id,
      t: new Date().toISOString(),
      method: req.method(),
      url: res.url(),
      status: res.status(),
      ok: res.ok(),
      resourceType: req.resourceType(),
      ms,
    };
    const reqBuf = this.reqBodyByReq.get(req);
    if (reqBuf) {
      this.storeBody(this.reqBodies, id, {
        buf: reqBuf,
        contentType: req.headers()["content-type"] ?? null,
      });
      entry.reqBytes = reqBuf.length;
      entry.reqType = req.headers()["content-type"] ?? null;
    }
    entry.resType = res.headers()["content-type"] ?? null;
    this.pushNet(entry);
    this.responses.set(id, res);
    await this.cacheResponseBody(id, res);
    const stored = this.resBodies.get(id);
    if (stored) entry.resBytes = stored.buf.length;
  }

  private pushNet(entry: NetEntry): void {
    this.netEntries.push(entry);
    if (this.netEntries.length > 4000) this.netEntries.splice(0, 1500);
  }

  async headersFor(id: number): Promise<Record<string, string> | null> {
    const res = this.responses.get(id);
    if (!res) return null;
    try {
      return res.headers();
    } catch {
      return null;
    }
  }

  private async ensureResponseBody(
    id: number,
  ): Promise<{ buf: Buffer; contentType: string | null } | null> {
    const cached = this.resBodies.get(id);
    if (cached) return cached;
    const res = this.responses.get(id);
    if (!res) return null;
    try {
      const buf = await res.body();
      const contentType = res.headers()["content-type"] ?? null;
      this.storeBody(this.resBodies, id, { buf, contentType });
      const entry = this.netEntries.find((e) => e.id === id);
      if (entry) entry.resBytes = buf.length;
      return { buf, contentType };
    } catch {
      return null;
    }
  }

  /** Cuerpo de respuesta en crudo (JSON, texto o binario con base64/hex). */
  async bodyView(
    id: number,
    opts: { maxChars?: number; includeRaw?: boolean; maxRawBytes?: number } = {},
  ): Promise<BodyView | null> {
    const stored = await this.ensureResponseBody(id);
    if (!stored) return null;
    return describeBuffer("response", stored.buf, stored.contentType, {
      maxChars: opts.maxChars ?? 4000,
      includeRaw: opts.includeRaw ?? false,
      maxRawBytes: opts.maxRawBytes ?? 256 * 1024,
    });
  }

  /** Cuerpo de request en crudo: imprescindible para ver protocolos binarios. */
  async requestView(
    id: number,
    opts: { maxChars?: number; includeRaw?: boolean; maxRawBytes?: number } = {},
  ): Promise<BodyView | null> {
    const stored = this.reqBodies.get(id);
    if (!stored) return null;
    return describeBuffer("request", stored.buf, stored.contentType, {
      maxChars: opts.maxChars ?? 4000,
      includeRaw: opts.includeRaw ?? false,
      maxRawBytes: opts.maxRawBytes ?? 256 * 1024,
    });
  }

  async bodyFor(
    id: number,
    maxChars = 4000,
  ): Promise<{ text: string; json?: unknown; kind?: string } | null> {
    const view = await this.bodyView(id, { maxChars, includeRaw: false });
    if (!view) return null;
    return {
      text:
        view.text ??
        `[${view.kind} ${view.bytes} B${view.contentType ? `, ${view.contentType}` : ""}]`,
      json: view.json,
      kind: view.kind,
    };
  }

  async find(
    params: ClickParams & { labels?: string[] },
  ): Promise<{ locator: Locator; desc: string; frame: Frame } | null> {
    const page = this.ensurePage();
    const timeout = params.timeoutMs ?? 5000;
    const deadline = Date.now() + timeout;

    const makers: Array<{ desc: string; make: (f: Frame) => Locator }> = [];
    if (params.selector) {
      const sel = params.selector;
      makers.push({ desc: `selector=${sel}`, make: (f) => f.locator(sel) });
    }
    const names = params.name ? [params.name] : params.labels ?? [];
    for (const n of names) {
      makers.push({ desc: `role=${params.role ?? "button"} name~${n}`, make: (f) => f.getByRole(params.role ?? "button", { name: n, exact: params.exact ?? false }) });
    }
    if (params.text) {
      makers.push({ desc: `text=${params.text}`, make: (f) => f.getByText(params.text!, { exact: params.exact ?? false }) });
    }

    do {
      for (const frame of page.frames()) {
        if (params.frameUrlIncludes && !frame.url().includes(params.frameUrlIncludes)) continue;
        for (const maker of makers) {
          try {
            const loc = maker.make(frame);
            const count = await loc.count();
            for (let i = 0; i < Math.min(count, 8); i++) {
              const item = loc.nth(i);
              if (await item.isVisible().catch(() => false)) {
                return { locator: item, desc: maker.desc, frame };
              }
            }
          } catch {
            /* frame detachado o locator invalido */
          }
        }
      }
      await new Promise((r) => setTimeout(r, 200));
    } while (Date.now() < deadline);

    return null;
  }

  async click(params: ClickParams & { labels?: string[] }): Promise<{
    ok: boolean;
    desc: string | null;
    method: "click" | "dispatch" | null;
    frameUrl: string | null;
  }> {
    const found = await this.find(params);
    if (!found) {
      return { ok: false, desc: null, method: null, frameUrl: null };
    }
    const { locator, desc, frame } = found;
    try {
      await locator.click({ timeout: params.timeoutMs ?? 8000 });
      return { ok: true, desc, method: "click", frameUrl: frame.url() };
    } catch {
      // Overlays/canvas a veces bloquean el click real: disparamos el evento igualmente.
      try {
        await locator.dispatchEvent("click");
        return { ok: true, desc, method: "dispatch", frameUrl: frame.url() };
      } catch (err) {
        throw new Error(`Encontre el elemento (${desc}) pero no pude hacer click: ${String(err)}`);
      }
    }
  }

  async clickAt(
    x: number,
    y: number,
    opts: { frameUrlIncludes?: string } = {},
  ): Promise<{ x: number; y: number; frameUrl: string | null }> {
    const page = this.ensurePage();
    let cx = x;
    let cy = y;
    let frameUrl: string | null = null;

    if (opts.frameUrlIncludes) {
      const frame = page.frames().find((f) => f.url().includes(opts.frameUrlIncludes!));
      if (!frame) throw new Error(`No hay frame cuya URL incluya "${opts.frameUrlIncludes}"`);
      frameUrl = frame.url();
      const handle = await frame.frameElement();
      const box = await handle.boundingBox();
      if (box) {
        cx += box.x;
        cy += box.y;
      }
    } else {
      frameUrl = page.mainFrame().url();
    }

    await page.mouse.click(cx, cy);
    return { x: cx, y: cy, frameUrl };
  }

  // ----------------------------------------------------- mapa de coordenadas
  async buildMap(): Promise<MapEntry[]> {
    const page = this.ensurePage();
    const raw: Array<Omit<MapEntry, "id" | "n" | "aliases" | "frameUrl">> = [];

    for (const frame of page.frames()) {
      let offset = { x: 0, y: 0 };
      if (frame !== page.mainFrame()) {
        try {
          const handle = await frame.frameElement();
          const box = await handle.boundingBox();
          if (!box) continue;
          offset = { x: box.x, y: box.y };
        } catch {
          continue;
        }
      }

      let found: Array<Omit<MapEntry, "id" | "n" | "aliases" | "frameUrl">> = [];
      try {
        found = await frame.evaluate(() => {
          type Raw = {
            x: number;
            y: number;
            w: number;
            h: number;
            label: string;
            tag: string;
            role?: string;
            testid?: string;
            cursor: string;
          };
          const vw = window.innerWidth;
          const vh = window.innerHeight;
          const out: Raw[] = [];
          const seen = new Set<string>();

          const labelOf = (el: Element): string => {
            const h = el as HTMLElement;
            return (
              el.getAttribute("aria-label") ||
              h.innerText ||
              el.getAttribute("title") ||
              el.getAttribute("name") ||
              (el as HTMLInputElement).value ||
              el.getAttribute("alt") ||
              el.id ||
              el.getAttribute("data-testid") ||
              ""
            )
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 48);
          };

          const push = (el: Element) => {
            if (out.length >= 60) return;
            const r = el.getBoundingClientRect();
            if (r.width < 8 || r.height < 8) return;
            if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) return;
            const s = getComputedStyle(el);
            if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity || "1") < 0.05) return;
            if ((el as HTMLButtonElement).disabled) return;
            const key = [r.x, r.y, r.width, r.height].map((v) => Math.round(v)).join(",");
            if (seen.has(key)) return;
            const label = labelOf(el);
            if (!label) return;
            seen.add(key);
            out.push({
              x: Math.round(r.x),
              y: Math.round(r.y),
              w: Math.round(r.width),
              h: Math.round(r.height),
              label,
              tag: el.tagName.toLowerCase(),
              role: el.getAttribute("role") ?? undefined,
              testid: el.getAttribute("data-testid") ?? undefined,
              cursor: s.cursor,
            });
          };

          document
            .querySelectorAll(
              'button, a, input, select, [role="button"], [role="link"], [role="radio"], [role="checkbox"], [onclick], [class*="btn"], [class*="button"]',
            )
            .forEach(push);

          // Segunda pasada: botones hechos con div/span (cursor pointer sin rol).
          if (out.length < 40) {
            let scanned = 0;
            for (const el of Array.from(document.querySelectorAll("body *"))) {
              if (++scanned > 4000 || out.length >= 50) break;
              const s = getComputedStyle(el);
              if (s.cursor !== "pointer") continue;
              if (el.children.length > 2) continue;
              push(el);
            }
          }
          return out;
        });
      } catch {
        continue;
      }

      for (const item of found) {
        raw.push({
          ...item,
          x: item.x + offset.x,
          y: item.y + offset.y,
        });
      }
    }

    raw.sort((a, b) => a.y - b.y || a.x - b.x);
    const limited = raw.slice(0, 40);
    const cfg = loadConfig();

    const used = new Map<string, number>();
    return limited.map((item, index) => {
      const slug = slugify(item.label);
      const canonical = canonicalId(item.label, cfg);
      const base = canonical ?? slug ?? item.tag;
      const count = (used.get(base) ?? 0) + 1;
      used.set(base, count);
      const id = count === 1 ? base : `${base}-${count}`;
      const aliases = [...new Set([slug, canonical].filter((a): a is string => !!a && a !== id))];
      return {
        ...item,
        n: index + 1,
        id,
        aliases,
        frameUrl: page.url(),
      };
    });
  }

  private async injectOverlay(entries: MapEntry[]): Promise<void> {
    const page = this.ensurePage();
    await page.evaluate((items) => {
      document.getElementById("__slots_map_overlay")?.remove();
      const root = document.createElement("div");
      root.id = "__slots_map_overlay";
      root.style.cssText =
        "position:fixed;inset:0;pointer-events:none;z-index:2147483647;font-family:ui-monospace,monospace;";
      for (const e of items) {
        const box = document.createElement("div");
        box.style.cssText = `position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;border:2px solid #00e5ff;background:rgba(0,229,255,0.10);box-sizing:border-box;`;
        const badge = document.createElement("div");
        badge.textContent = String(e.n);
        badge.style.cssText = `position:absolute;left:-2px;top:${e.y < 18 ? "0" : "-16px"};background:#00e5ff;color:#001018;font:700 11px/16px ui-monospace,monospace;padding:0 4px;border-radius:3px;`;
        box.appendChild(badge);
        root.appendChild(box);
      }
      document.documentElement.appendChild(root);
    }, entries);
  }

  private async removeOverlay(): Promise<void> {
    await this.page
      ?.evaluate(() => document.getElementById("__slots_map_overlay")?.remove())
      .catch(() => undefined);
  }

  coordsPath(): string {
    return path.join(loadConfig().artifactsDir, "coords.json");
  }

  saveCoords(entries: MapEntry[], meta: { url: string; viewport: { width: number; height: number } }): string {
    const file = this.coordsPath();
    ensureDir(path.dirname(file));
    fs.writeFileSync(
      file,
      JSON.stringify({ savedAt: new Date().toISOString(), ...meta, entries }, null, 2),
      "utf8",
    );
    return file;
  }

  loadCoords(): { savedAt: string; url: string; entries: MapEntry[] } | null {
    try {
      return JSON.parse(fs.readFileSync(this.coordsPath(), "utf8"));
    } catch {
      return null;
    }
  }

  async captureMap(opts: { overlay?: boolean; save?: boolean }): Promise<{
    entries: MapEntry[];
    path: string | null;
    base64: string;
    coordsFile: string | null;
  }> {
    const page = this.ensurePage();
    const entries = await this.buildMap();
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };

    let buf: Buffer;
    try {
      if (opts.overlay !== false) await this.injectOverlay(entries);
      buf = await page.screenshot({ type: "png" });
    } finally {
      await this.removeOverlay();
    }

    const cfg = loadConfig();
    let filePath: string | null = null;
    if (opts.save !== false) {
      filePath = artifactPath(cfg.artifactsDir, "map", "png");
      fs.writeFileSync(filePath, buf);
    }
    const coordsFile =
      opts.save !== false ? this.saveCoords(entries, { url: page.url(), viewport }) : null;

    return { entries, path: filePath, base64: buf.toString("base64"), coordsFile };
  }

  /**
   * Mapa de nodos del motor (Cocos Creator 2.x). A diferencia de buildMap (DOM), lee el
   * arbol de la escena y traduce cada nodo a coordenadas de viewport, con IDs canonicos.
   */
  async canvasMap(
    opts: { minSize?: number; includeAll?: boolean; screenshot?: boolean; save?: boolean; maxNodes?: number } = {},
  ): Promise<{
    engine: string;
    calibration: {
      canvas: { x: number; y: number; w: number; h: number };
      design: { width: number; height: number } | null;
      scaleX: number;
      scaleY: number;
      policy: string | null;
    } | null;
    entries: MapEntry[];
    skipped: number;
    sceneNodes: number;
    path: string | null;
    base64: string | null;
    coordsFile: string | null;
    warning: string | null;
  }> {
    const page = this.ensurePage();
    const cfg = loadConfig();

    const scanned = await page.evaluate(
      (arg) => {
        const w = window as unknown as Record<string, unknown>;
        const cc = w.cc as any;
        const canvasEl =
          document.querySelector(arg.canvasSelector || "canvas") || document.querySelector("canvas");
        const box = canvasEl ? canvasEl.getBoundingClientRect() : null;
        const base = {
          engine: "dom" as string,
          calibration: null as unknown,
          hits: [] as Array<Record<string, unknown>>,
          sceneNodes: 0,
          warning: null as string | null,
        };
        if (!cc || !cc.director || !cc.director.getScene || !box) {
          base.warning = cc
            ? "No encontre el canvas."
            : "No hay motor Cocos (window.cc). Para DOM usa slots_map.";
          return base;
        }

        const design = cc.view && cc.view.getDesignResolutionSize ? cc.view.getDesignResolutionSize() : null;
        const scaleX = cc.view && cc.view.getScaleX ? cc.view.getScaleX() : design ? box.width / design.width : 1;
        const scaleY = cc.view && cc.view.getScaleY ? cc.view.getScaleY() : design ? box.height / design.height : 1;
        let policy: string | null = null;
        try {
          const p = cc.view && cc.view.getResolutionPolicy ? cc.view.getResolutionPolicy() : null;
          const name = p && (p.name || p._name);
          policy = typeof name === "string" ? name : p && p.isFitHeight ? "FIT_HEIGHT" : p && p.isFitWidth ? "FIT_WIDTH" : null;
        } catch {
          policy = null;
        }

        base.engine = "cocos2d";
        base.calibration = {
          canvas: { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) },
          design: design ? { width: design.width, height: design.height } : null,
          scaleX,
          scaleY,
          policy,
        };

        const scene = cc.director.getScene();
        const toScreen = (worldX: number, worldY: number) => ({
          x: box.x + worldX * scaleX,
          y: box.y + box.height - worldY * scaleY,
        });

        // Nombre -> tokens: "spin_button_controller" => "spin button controller",
        // "background" => "background" (no debe confundirse con "back").
        const tokens = (raw: string): string =>
          String(raw)
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[^a-zA-Z0-9]+/g, " ")
            .trim()
            .toLowerCase();
        const interesting =
          /\b(btn|button|icon|menu|toggle|spin|bet|wallet|auto|turbo|buy|bonus|back|close|setting|info|payout|plus|minus|max|confirm|start|play|gamble|feature|verify|option|rules|help|exit|replay)\b/;
        const noisy = /\b(toast|tooltip|debug|fps|background|dim|mask|tint|glow|effect|particle|animation)\b/;

        // Un nodo "se dibuja" si el subarbol tiene algo visible (sprite con frame,
        // label con texto, graphics, particulas o spine). Evita botones fantasma
        // que existen en la escena pero no se pintan (ej. celdas de paytable).
        const subtreeDraws = (root: any): boolean => {
          if (!root) return false;
          const stack: any[] = [root];
          let guard = 0;
          while (stack.length && guard++ < 120) {
            const cur = stack.pop();
            if (!cur || !cur.activeInHierarchy) continue;
            if (typeof cur.opacity === "number" && cur.opacity < 8) continue;
            for (const c of cur._components || []) {
              if (!c || c.enabled === false) continue;
              const cls = c.__classname__ || "";
              if (cls === "cc.Sprite" && c.spriteFrame) return true;
              if ((cls === "cc.Label" || cls === "cc.RichText") && c.string) return true;
              if (cls === "cc.Graphics" || cls === "cc.ParticleSystem") return true;
              if (cls === "sp.Skeleton" && c.skeletonData) return true;
            }
            for (const k of cur.children || []) if (k.activeInHierarchy) stack.push(k);
          }
          return false;
        };

        let visited = 0;
        const walk = (node: any, pathStr: string): void => {
          if (!node || visited >= arg.maxNodes) return;
          visited++;
          const name = String(node.name || "");
          const full = pathStr ? `${pathStr}/${name}` : name;
          try {
            if (node.activeInHierarchy) {
              const comps: string[] = (node._components || [])
                .map((c: any) => c && (c.__classname__ || (c.constructor && c.constructor.name)))
                .filter(Boolean);
              const passThrough = comps.some((c) => /HitPassThrough/i.test(c));
              const interactive =
                !passThrough &&
                (comps.includes("cc.Button") ||
                  comps.some((c) => /Button|Touchable|Clickable|SpinButtonView|BetModifier/i.test(c)));
              const tok = tokens(name);
              const named =
                arg.includeAll || (interesting.test(tok) && !noisy.test(tok));
              // Capas de efectos/animacion (pop-outs de simbolos, win effects): son
              // transitorias y no sirven para navegar.
              const effectLayer = /\b(pop out|effect)\b/.test(tokens(full));

              // El area tactil puede ser invisible si el grafico vive en un hermano
              // (ej. wallet_button sin sprite): miramos tambien el padre.
              const visible = subtreeDraws(node) || subtreeDraws(node.parent);

              // Por defecto solo lo realmente clickeable: los nodos solo-nombre son
              // decorativos (labels, holders) y ensucian el mapa.
              const keep = arg.includeAll
                ? (interactive || named) && visible && !effectLayer
                : interactive && visible && !effectLayer;

              if (keep) {
                const size = node.getContentSize ? node.getContentSize() : { width: 0, height: 0 };
                let bw = size.width;
                let bh = size.height;
                let worldX: number | null = null;
                let worldY: number | null = null;
                try {
                  if (node.getBoundingBoxToWorld) {
                    const bb = node.getBoundingBoxToWorld();
                    if (bb && bb.width > 0 && bb.height > 0) {
                      bw = bb.width;
                      bh = bb.height;
                      worldX = bb.x + bb.width / 2;
                      worldY = bb.y + bb.height / 2;
                    }
                  }
                } catch {
                  /* nodo sin bounding box */
                }
                if (worldX == null || worldY == null) {
                  try {
                    const p = node.convertToWorldSpaceAR(cc.v2(0, 0));
                    worldX = p.x;
                    worldY = p.y;
                  } catch {
                    worldX = null;
                  }
                }
                if (worldX != null && worldY != null && bw * scaleX >= arg.minSize && bh * scaleY >= arg.minSize) {
                  const center = toScreen(worldX, worldY);
                  const sw = bw * scaleX;
                  const sh = bh * scaleY;
                  let text = "";
                  try {
                    const lbl = node.getComponent && cc.Label ? node.getComponent(cc.Label) : null;
                    if (lbl && typeof lbl.string === "string") text = lbl.string.trim().slice(0, 30);
                  } catch {
                    /* sin label */
                  }
                  base.hits.push({
                    name,
                    path: full,
                    comps,
                    interactive,
                    text,
                    cx: Math.round(center.x),
                    cy: Math.round(center.y),
                    x: Math.round(center.x - sw / 2),
                    y: Math.round(center.y - sh / 2),
                    w: Math.round(sw),
                    h: Math.round(sh),
                  });
                }
              }
            }
          } catch {
            /* nodo problematico */
          }
          const kids = node.children || [];
          for (let i = 0; i < kids.length; i++) walk(kids[i], full);
        };

        walk(scene, "");
        base.sceneNodes = visited;
        return base;
      },
      {
        canvasSelector: cfg.selectors.canvas ?? "canvas",
        minSize: opts.minSize ?? 18,
        includeAll: opts.includeAll ?? false,
        maxNodes: opts.maxNodes ?? 20000,
      },
    );

    const calibration = scanned.calibration as {
      canvas: { x: number; y: number; w: number; h: number };
      design: { width: number; height: number } | null;
      scaleX: number;
      scaleY: number;
      policy: string | null;
    } | null;

    const hits = scanned.hits as CanvasHit[];

    // 1) Los interactivos mandan; 2) fuera duplicados por centro; 3) fuera contenedores
    //    que envuelven a un interactivo (barra inferior, mascaras); 4) fuera hijos
    //    decorativos cuyo centro ya cae dentro de otro elemento (iconos, labels).
    const sorted = [...hits].sort(
      (a, b) =>
        Number(b.interactive) - Number(a.interactive) || b.w * b.h - a.w * a.h,
    );
    const kept: CanvasHit[] = [];
    for (const hit of sorted) {
      const dup = kept.some((k) => Math.abs(k.cx - hit.cx) <= 6 && Math.abs(k.cy - hit.cy) <= 6);
      if (dup) continue;
      const wrapsOthers = kept.some(
        (k) =>
          hit.x <= k.x + 4 &&
          hit.y <= k.y + 4 &&
          hit.x + hit.w >= k.x + k.w - 4 &&
          hit.y + hit.h >= k.y + k.h - 4,
      );
      if (wrapsOthers) continue;
      const insideOther = kept.some(
        (k) => hit.cx >= k.x && hit.cx <= k.x + k.w && hit.cy >= k.y && hit.cy <= k.y + k.h,
      );
      if (!hit.interactive && insideOther) continue;
      kept.push(hit);
    }

    kept.sort((a, b) => a.cy - b.cy || a.cx - b.cx);

    const used = new Map<string, number>();
    const maxPerId = 4;
    const entries: MapEntry[] = [];
    for (const hit of kept) {
      const label = (hit.text || hit.name).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
      const canonical = canvasIdFor(hit, cfg);
      const base = canonical ?? slugify(hit.name) ?? "node";
      const count = (used.get(base) ?? 0) + 1;
      if (count > maxPerId) continue;
      used.set(base, count);
      const id = count === 1 ? base : `${base}-${count}`;
      const aliases = [...new Set([slugify(hit.name), canonical, hit.name].filter((a): a is string => !!a && a !== id))];
      entries.push({
        n: entries.length + 1,
        id,
        aliases,
        label,
        tag: "cocos",
        cursor: hit.interactive ? "pointer" : "-",
        x: hit.x,
        y: hit.y,
        w: hit.w,
        h: hit.h,
        frameUrl: page.url(),
        path: hit.path,
      });
    }

    let coordsFile: string | null = null;
    if (opts.save !== false) {
      const prev = this.loadCoords();
      // Solo se conservan las entradas DOM del MISMO origen: si no, un mapa viejo de
      // otro juego (o del fixture local) pisa IDs como "spin" y el click cae en el vacio.
      const origins = this.pageOrigins();
      const others = (prev?.entries ?? []).filter((e) => {
        if (e.tag === "cocos") return false;
        try {
          return !!e.frameUrl && origins.has(new URL(e.frameUrl).origin);
        } catch {
          return false;
        }
      });
      const merged = [...others, ...entries].map((e, i) => ({ ...e, n: i + 1 }));
      const viewport = page.viewportSize() ?? { width: 0, height: 0 };
      coordsFile = this.saveCoords(merged, { url: page.url(), viewport });
    }

    let base64: string | null = null;
    let filePath: string | null = null;
    if (opts.screenshot) {
      try {
        await this.injectOverlay(entries);
        const buf = await page.screenshot({ type: "png" });
        base64 = buf.toString("base64");
        filePath = artifactPath(cfg.artifactsDir, "canvas-map", "png");
        fs.writeFileSync(filePath, buf);
      } finally {
        await this.removeOverlay();
      }
    }

    return {
      engine: scanned.engine,
      calibration,
      entries,
      skipped: hits.length - entries.length,
      sceneNodes: scanned.sceneNodes,
      path: filePath,
      base64,
      coordsFile,
      warning: scanned.warning,
    };
  }

  /** Lee el estado interno del motor (saldo/premio/apuesta) sin depender de la animacion. */
  async probeEngine(
    opts: { treeDepth?: number; maxFields?: number; pattern?: string } = {},
  ): Promise<EngineProbe> {
    const page = this.ensurePage();
    const pattern = opts.pattern ?? "(balance|credit|cash|win|bet|stake|total|amount|payout)";
    const depthLimit = opts.treeDepth ?? 2;

    const raw = await page.evaluate(
      (arg) => {
        const w = window as unknown as Record<string, unknown>;
        const cc = w.cc as any;
        const canvasEl = document.querySelector("canvas");
        const box = canvasEl ? canvasEl.getBoundingClientRect() : null;
        const out: Record<string, any> = {
          engine: "dom",
          version: null,
          canvas: box
            ? {
                x: Math.round(box.x),
                y: Math.round(box.y),
                w: Math.round(box.width),
                h: Math.round(box.height),
                count: document.querySelectorAll("canvas").length,
              }
            : null,
          design: null,
          scale: null,
          resolutionPolicy: null,
          fields: [],
          labels: {},
          scene: null,
          globals: Object.keys(w)
            .filter((k) => /game|slot|state|balance|wallet|engine|^cc$|spin/i.test(k))
            .slice(0, 40),
          sceneNodes: 0,
          warning: null,
        };

        if (!cc || !cc.director || !cc.director.getScene) {
          out.warning = "Sin motor Cocos visible. Solo hay DOM; usa slots_state o slots_eval.";
          return out;
        }

        out.engine = "cocos2d";
        try {
          out.version =
            cc.ENGINE_VERSION ||
            (cc.game && cc.game.config && cc.game.config.engineVersion) ||
            (cc.sys && cc.sys.version) ||
            null;
        } catch {
          out.version = null;
        }
        try {
          out.design = cc.view.getDesignResolutionSize();
        } catch {
          out.design = null;
        }
        try {
          out.scale = cc.view.getScaleX();
        } catch {
          out.scale = null;
        }
        try {
          const p = cc.view.getResolutionPolicy();
          const pname = p && (p.name || p._name);
          out.resolutionPolicy =
            typeof pname === "string" ? pname : p && p.isFitHeight ? "FIT_HEIGHT" : p && p.isFitWidth ? "FIT_WIDTH" : null;
        } catch {
          out.resolutionPolicy = null;
        }

        const keyRe = new RegExp(arg.pattern, "i");
        const scene = cc.director.getScene();
        const tree: string[] = [];
        let visited = 0;

        const walk = (node: any, depth: number): void => {
          if (!node || visited >= 8000) return;
          visited++;
          const name = String(node.name || "");
          const label = name.toUpperCase();
          try {
            if (node.activeInHierarchy) {
              if (depth <= arg.treeDepth && name) tree.push(`${"  ".repeat(depth)}${name}`);

              for (const comp of node._components || []) {
                if (!comp) continue;
                const cls =
                  comp.__classname__ || (comp.constructor && comp.constructor.name) || "component";
                const values: Record<string, number | string | boolean> = {};
                let count = 0;
                let keys: string[] = [];
                try {
                  keys = Object.keys(comp);
                } catch {
                  keys = [];
                }
                for (const k of keys) {
                  if (k === "node" || k === "enabled" || k.startsWith("__")) continue;
                  let v: unknown;
                  try {
                    v = (comp as Record<string, unknown>)[k];
                  } catch {
                    continue;
                  }
                  const t = typeof v;
                  if (t !== "number" && t !== "string" && t !== "boolean") continue;
                  if (t === "string" && (v as string).length > 60) continue;
                  if (!keyRe.test(k)) continue;
                  values[k] = v as number | string | boolean;
                  if (++count >= arg.maxFields) break;
                }
                if (count) out.fields.push({ node: name, comp: cls, values });
              }

              try {
                const lbl = node.getComponent && cc.Label ? node.getComponent(cc.Label) : null;
                const text = lbl && typeof lbl.string === "string" ? lbl.string.trim() : "";
                if (text && Object.keys(out.labels).length < 40) {
                  if (/balance|bet|win|cash|credit|amount|total|pay/i.test(label)) out.labels[name] = text;
                  else if (/^[\d.,\s$€£]+$/.test(text) && text.length <= 18) out.labels[name] = text;
                }
              } catch {
                /* sin label */
              }
            }
          } catch {
            /* nodo problematico */
          }
          const kids = node.children || [];
          for (let i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
        };

        walk(scene, 0);
        out.sceneNodes = visited;
        out.scene = tree;
        return out;
      },
      { pattern, treeDepth: depthLimit, maxFields: opts.maxFields ?? 12 },
    ).catch((err: unknown) => ({ __navError: String(err) }) as Record<string, any>);

    // Sondeo de carga: durante el redirect/recarga el contexto se destruye y evaluate
    // lanza. Devolvemos un estado vacio en vez de romper el poll del agente.
    if ((raw as { __navError?: string }).__navError) {
      return {
        engine: "unknown",
        version: null,
        canvas: null,
        design: null,
        scale: null,
        resolutionPolicy: null,
        state: null,
        fields: [],
        labels: {},
        scene: null,
        globals: [],
        sceneNodes: 0,
        warning: `La pagina esta cargando o navegando (${(raw as { __navError?: string }).__navError?.slice(0, 180)}). Reintenta en 1-2 s.`,
      };
    }

    const fields = (raw.fields as EngineProbe["fields"]).slice(0, 40);
    const labels = raw.labels as Record<string, string>;
    const num = (v: unknown): number | null => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") return parseAmount(v);
      return null;
    };
    const first = (values: Record<string, unknown>, keys: RegExp): number | null => {
      for (const [k, v] of Object.entries(values)) {
        if (!keys.test(k)) continue;
        const n = num(v);
        if (n != null) return n;
      }
      return null;
    };

    const source =
      fields.find((f) => /balance/i.test(Object.keys(f.values).join(" "))) ??
      fields.find((f) => /(bet|win|credit|cash)/i.test(Object.keys(f.values).join(" "))) ??
      null;

    let state: EngineProbe["state"] = null;
    if (source) {
      state = {
        balance: first(source.values, /^(currentBalance|balance|cashBalance|totalBalance|credit)$/i) ??
          first(source.values, /balance|credit|cash/i),
        targetBalance: first(source.values, /^(targetBalance|target)$/i),
        win: first(source.values, /^(winBalance|lastWin|win|totalWin)$/i) ?? first(source.values, /win/i),
        bet: first(source.values, /^(betAmount|currentBet|totalBet|bet|stake)$/i) ?? first(source.values, /bet|stake/i),
        source: `${source.node} / ${source.comp}`,
      };
    }

    // Respaldo: etiquetas del canvas (BalanceValue, bet_amount_value...).
    if (state) {
      if (state.balance == null) {
        const k = Object.keys(labels).find((x) => /balance|credit|cash/i.test(x));
        if (k) state.balance = parseAmount(labels[k]);
      }
      if (state.bet == null) {
        const k = Object.keys(labels).find((x) => /bet|stake/i.test(x));
        if (k) state.bet = parseAmount(labels[k]);
      }
      if (state.win == null) {
        const k = Object.keys(labels).find((x) => /win|pay/i.test(x));
        if (k) state.win = parseAmount(labels[k]);
      }
    }

    return {
      engine: raw.engine as string,
      version: (raw.version as string | null) ?? null,
      canvas: raw.canvas as EngineProbe["canvas"],
      design: raw.design as EngineProbe["design"],
      scale: (raw.scale as number | null) ?? null,
      resolutionPolicy: (raw.resolutionPolicy as string | null) ?? null,
      state,
      fields,
      labels,
      scene: (raw.scene as string[] | null) ?? null,
      globals: (raw.globals as string[]) ?? [],
      sceneNodes: Number(raw.sceneNodes ?? 0),
      warning: (raw.warning as string | null) ?? null,
    };
  }

  private async probeAt(x: number, y: number): Promise<{
    tag: string;
    text: string;
    aria: string | null;
    id: string | null;
    cls: string | null;
  } | null> {
    const page = this.ensurePage();
    try {
      return await page.evaluate(
        ({ x, y }) => {
          const el = document.elementFromPoint(x, y);
          if (!el) return null;
          return {
            tag: el.tagName.toLowerCase(),
            text: ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
            aria: el.getAttribute("aria-label"),
            id: el.id || null,
            cls: (el.className || "").toString().slice(0, 60) || null,
          };
        },
        { x, y },
      );
    } catch {
      return null;
    }
  }

  async clickId(
    id: string,
    opts: {
      strict?: boolean;
      autoConfirm?: boolean;
      confirmTimeoutMs?: number;
      waitForNetwork?: string;
      settleMs?: number;
    } = {},
  ): Promise<{
    ok: boolean;
    entry: MapEntry | null;
    drift: boolean;
    probe: unknown;
    /** Elemento DOM que tapa el punto (overlay de carga, modal...). */
    blockedBy: unknown;
    clickedAt: { x: number; y: number } | null;
    confirmed: { clicked: boolean; label: string | null } | null;
    network: { url: string; status: number } | null;
    warning: string | null;
  }> {
    const page = this.ensurePage();
    const cache = this.loadCoords();
    if (!cache) {
      return {
        ok: false,
        entry: null,
        drift: false,
        probe: null,
        blockedBy: null,
        clickedAt: null,
        confirmed: null,
        network: null,
        warning: "No hay coordenadas guardadas. Usa slots_map primero.",
      };
    }
    // Mismo origen primero (y coincidencia exacta de id antes que alias): un coords.json
    // viejo de otro juego no debe secuestrar "spin".
    const origins = this.pageOrigins();
    const matches = cache.entries.filter(
      (e) => e.id === id || e.aliases?.includes(id) || String(e.n) === id,
    );
    const current = matches.filter((e) => {
      try {
        return !!e.frameUrl && origins.has(new URL(e.frameUrl).origin);
      } catch {
        return false;
      }
    });
    const entry = current.find((e) => e.id === id) ?? current[0];
    if (!entry) {
      const foreign = matches[0];
      return {
        ok: false,
        entry: foreign ?? null,
        drift: false,
        probe: null,
        blockedBy: null,
        clickedAt: null,
        confirmed: null,
        network: null,
        warning: foreign
          ? `La coordenada "${id}" esta guardada para ${foreign.frameUrl}, que no es esta pagina. Vuelve a mapear aqui: slots_canvas_map (canvas) o slots_map (DOM).`
          : `No existe la coordenada "${id}". Guardadas: ${cache.entries.map((e) => e.id).join(", ")}`,
      };
    }

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    // Los botones del canvas pueden sobresalir unos px del canvas (el de spin, 8 px
    // por abajo): se valida el CENTRO y se recorta el punto al area visible.
    let cx = entry.x + entry.w / 2;
    let cy = entry.y + entry.h / 2;
    if (entry.tag === "cocos") {
      const cfg = loadConfig();
      const rect = await page
        .evaluate((sel) => {
          const el = document.querySelector(sel) || document.querySelector("canvas");
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { x: b.x, y: b.y, w: b.width, h: b.height };
        }, cfg.selectors.canvas ?? "canvas")
        .catch(() => null);
      if (rect && rect.w > 0 && rect.h > 0) {
        cx = Math.min(Math.max(cx, rect.x + 2), rect.x + rect.w - 2);
        cy = Math.min(Math.max(cy, rect.y + 2), rect.y + rect.h - 2);
      }
    }
    const inside = cx >= 0 && cy >= 0 && cx <= viewport.width && cy <= viewport.height;
    if (!inside) {
      return {
        ok: false,
        entry,
        drift: true,
        probe: null,
        blockedBy: null,
        clickedAt: null,
        confirmed: null,
        network: null,
        warning: "La coordenada queda fuera del viewport actual. Vuelve a mapear con slots_map.",
      };
    }

    const probe = await this.probeAt(cx, cy);
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
    const probeText = norm(`${probe?.text ?? ""} ${probe?.aria ?? ""}`);
    // Los nodos del motor (canvas) no tienen texto en el DOM: el drift solo aplica al mapa DOM.
    const drift =
      entry.tag !== "cocos" &&
      !!probe &&
      probe.tag !== "iframe" &&
      probe.tag !== "canvas" &&
      !probeText.includes(norm(entry.label).slice(0, 12)) &&
      !norm(entry.label).includes(norm(probe.text ?? "").slice(0, 12));

    // En juegos canvas, si lo que hay en el punto no es el canvas, hay un overlay DOM
    // encima (aviso de carga, modal, cookie banner): el click se perderia.
    const blockedBy =
      entry.tag === "cocos" && probe && probe.tag !== "canvas" && probe.tag !== "iframe" ? probe : null;

    if (drift && opts.strict) {
      return {
        ok: false,
        entry,
        drift,
        probe,
        blockedBy,
        clickedAt: null,
        confirmed: null,
        network: null,
        warning:
          "La UI cambio en esa coordenada y strict=true. Vuelve a mapear con slots_map si el elemento se movio.",
      };
    }

    const cfg = loadConfig();
    let responsePromise: Promise<Response | null> | null = null;
    if (opts.waitForNetwork !== undefined) {
      const pattern = opts.waitForNetwork || cfg.network.spinEndpoint;
      if (pattern) {
        const re = new RegExp(pattern, "i");
        responsePromise = page
          .waitForResponse((r) => re.test(r.url()) && r.request().method() !== "OPTIONS", {
            timeout: cfg.spin.timeoutMs,
          })
          .catch(() => null);
      }
    }

    await page.mouse.click(cx, cy);

    let confirmed: { clicked: boolean; label: string | null } | null = null;
    if (opts.autoConfirm) {
      confirmed = await this.confirmClick({ timeoutMs: opts.confirmTimeoutMs ?? 1500 });
    }

    let network: { url: string; status: number } | null = null;
    if (responsePromise) {
      const res = await responsePromise;
      if (res) network = { url: res.url(), status: res.status() };
    }
    if (opts.settleMs) await page.waitForTimeout(opts.settleMs);

    return {
      ok: true,
      entry,
      drift,
      probe,
      blockedBy,
      clickedAt: { x: Math.round(cx), y: Math.round(cy) },
      confirmed,
      network,
      warning:
        [
          blockedBy
            ? `Aviso: habia un overlay DOM en ese punto (${blockedBy.tag}${blockedBy.cls ? `.${blockedBy.cls}` : ""}). Puede haberse comido el click; reintenta cuando desaparezca.`
            : null,
          drift
            ? "Aviso: el texto bajo esa coordenada no coincide con el guardado (posible scroll o layout distinto), pero hice el click."
            : null,
        ]
          .filter(Boolean)
          .join(" ") || null,
    };
  }

  async confirmClick(opts: { labels?: string[]; timeoutMs?: number } = {}): Promise<{
    clicked: boolean;
    label: string | null;
  }> {
    const page = this.ensurePage();
    const cfg = loadConfig();
    const labels = (opts.labels?.length ? opts.labels : cfg.labels.confirm).map((l) =>
      l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    );
    const pattern = `^(${labels.join("|")})\\b`;
    const deadline = Date.now() + (opts.timeoutMs ?? 1500);

    do {
      for (const frame of page.frames()) {
        let candidates: Array<{ x: number; y: number; w: number; h: number; label: string; inDialog: boolean }> = [];
        try {
          candidates = await frame.evaluate((pat) => {
            const re = new RegExp(pat, "i");
            const vh = window.innerHeight;
            const vw = window.innerWidth;
            const out: Array<{ x: number; y: number; w: number; h: number; label: string; inDialog: boolean }> = [];
            const nodes = document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]');
            for (const el of Array.from(nodes)) {
              if (out.length >= 30) break;
              const r = el.getBoundingClientRect();
              if (r.width < 6 || r.height < 6) continue;
              if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
              const s = getComputedStyle(el);
              if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity || "1") < 0.05)
                continue;
              const text = (
                el.getAttribute("aria-label") ||
                (el as HTMLElement).innerText ||
                (el as HTMLInputElement).value ||
                ""
              )
                .replace(/\s+/g, " ")
                .trim();
              if (!re.test(text)) continue;
              const inDialog = !!el.closest(
                '[role="dialog"], [aria-modal="true"], .modal, [class*="modal"], [class*="dialog"], [class*="popup"]',
              );
              out.push({
                x: Math.round(r.x),
                y: Math.round(r.y),
                w: Math.round(r.width),
                h: Math.round(r.height),
                label: text.slice(0, 40),
                inDialog,
              });
            }
            return out;
          }, pattern);
        } catch {
          continue;
        }

        if (!candidates.length) continue;

        let offset = { x: 0, y: 0 };
        if (frame !== page.mainFrame()) {
          try {
            const box = await (await frame.frameElement()).boundingBox();
            if (!box) continue;
            offset = { x: box.x, y: box.y };
          } catch {
            continue;
          }
        }

        candidates.sort((a, b) => Number(b.inDialog) - Number(a.inDialog) || a.w * a.h - b.w * b.h);
        const best = candidates[0]!;
        await page.mouse.click(offset.x + best.x + best.w / 2, offset.y + best.y + best.h / 2);
        return { clicked: true, label: best.label };
      }
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);

    return { clicked: false, label: null };
  }

  async buttonsMontage(opts: { ids?: string[]; max?: number } = {}): Promise<{
    items: Array<{ n: number; id: string; label: string; x: number; y: number; w: number; h: number }>;
    base64: string;
    path: string | null;
  }> {
    const page = this.ensurePage();
    const cache = this.loadCoords();
    const all = cache?.entries ?? (await this.buildMap());

    let picked = all;
    if (opts.ids?.length) {
      const wanted = new Set(opts.ids);
      picked = all.filter((e) => wanted.has(e.id) || wanted.has(String(e.n)));
    }
    picked = picked.slice(0, Math.min(opts.max ?? 12, 24));

    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const crops: Buffer[] = [];
    const items: Array<{ n: number; id: string; label: string; x: number; y: number; w: number; h: number }> = [];

    for (const entry of picked) {
      const x = Math.max(0, entry.x);
      const y = Math.max(0, entry.y);
      const w = Math.min(entry.w, viewport.width - x);
      const h = Math.min(entry.h, viewport.height - y);
      if (w < 4 || h < 4) continue;
      try {
        const buf = await page.screenshot({ type: "png", clip: { x, y, width: w, height: h } });
        crops.push(buf);
        items.push({ n: entry.n, id: entry.id, label: entry.label, x, y, w, h });
      } catch {
        /* recorte fuera de rango */
      }
    }

    const cfg = loadConfig();
    let base64: string;
    let filePath: string | null = null;

    if (crops.length === 1) {
      base64 = crops[0]!.toString("base64");
    } else if (crops.length === 0) {
      throw new Error("No hay botones utilizables con coordenadas guardadas. Llama a slots_map primero.");
    } else {
      const montage = composeMontage(crops);
      base64 = montage.toString("base64");
      filePath = artifactPath(cfg.artifactsDir, "buttons", "png");
      fs.writeFileSync(filePath, montage);
    }

    return { items, base64, path: filePath };
  }

  private async textOf(selector: string | undefined): Promise<{ raw: string; frameUrl: string } | null> {
    if (!selector) return null;
    const page = this.ensurePage();
    for (const frame of page.frames()) {
      try {
        const loc = frame.locator(selector).first();
        if ((await loc.count()) === 0) continue;
        if (!(await loc.isVisible().catch(() => false))) continue;
        const raw = (await loc.innerText({ timeout: 1000 })).trim();
        if (raw) return { raw, frameUrl: frame.url() };
      } catch {
        /* ignore */
      }
    }
    return null;
  }

  async readState(): Promise<SlotState> {
    const page = this.ensurePage();
    const cfg = loadConfig();

    const balance = await this.textOf(cfg.selectors.balance);
    const bet = await this.textOf(cfg.selectors.bet);
    const win = await this.textOf(cfg.selectors.win);

    let textFallback: string | null = null;
    if (!balance || !bet || !win) {
      // Heuristica: buscar "balance/saldo/apuesta/ganancia" en el texto visible.
      for (const frame of page.frames()) {
        try {
          const body = await frame.locator("body").innerText({ timeout: 800 });
          if (body && body.length > 40) {
            textFallback = body.slice(0, 20000);
            break;
          }
        } catch {
          /* ignore */
        }
      }
    }

    const fromText = (re: RegExp): FieldValue => {
      if (!textFallback) return EMPTY_FIELD;
      const m = re.exec(textFallback);
      if (!m?.[1]) return EMPTY_FIELD;
      return { value: parseAmount(m[1]), raw: m[0].trim(), source: "body-text-heuristic" };
    };

    const toField = (found: { raw: string; frameUrl: string } | null, fb: () => FieldValue): FieldValue =>
      found
        ? { value: parseAmount(found.raw), raw: found.raw, source: `selector (${found.frameUrl})` }
        : fb();

    return {
      url: page.url(),
      title: await page.title().catch(() => null),
      frameUrl: balance?.frameUrl ?? null,
      balance: toField(balance, () =>
        fromText(/(?:balance|saldo|cr[eé]dito|credits?|coins?)[^\d\-]{0,15}([\d.,]+\d|\d)/i),
      ),
      bet: toField(bet, () => fromText(/(?:apuesta|bet|stake)[^\d\-]{0,15}([\d.,]+\d|\d)/i)),
      win: toField(win, () => fromText(/(?:ganancia|win|premio|won|payout)[^\d\-]{0,15}([\d.,]+\d|\d)/i)),
    };
  }

  private async waitForBalanceChange(before: number | null, timeoutMs: number): Promise<boolean> {
    if (before == null) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const state = await this.readState().catch(() => null);
      const now = state?.balance.value;
      if (now != null && Math.abs(now - before) > 1e-9) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async spin(opts: {
    waitForNetwork?: boolean;
    settleMs?: number;
    timeoutMs?: number;
  }): Promise<{
    before: SlotState;
    after: SlotState;
    delta: number | null;
    clicked: { ok: boolean; desc: string | null; method: string | null };
    network: NetEntry | null;
    payload: { text: string; json?: unknown } | null;
    moneyFields: Record<string, number | string>;
    balanceChanged: boolean;
    durationMs: number;
  }> {
    const cfg: SlotsConfig = loadConfig();
    const page = this.ensurePage();
    const started = Date.now();
    const timeoutMs = opts.timeoutMs ?? cfg.spin.timeoutMs;
    const settleMs = opts.settleMs ?? cfg.spin.settleMs;

    const before = await this.readState();

    let responsePromise: Promise<Response | null> | null = null;
    const endpoint = cfg.network.spinEndpoint;
    const wantNetwork = opts.waitForNetwork ?? cfg.spin.waitForNetwork;
    if (wantNetwork && endpoint) {
      const re = new RegExp(endpoint, "i");
      responsePromise = page
        .waitForResponse((r) => re.test(r.url()) && r.request().method() !== "OPTIONS", { timeout: timeoutMs })
        .catch(() => null);
    }

    const clicked = await this.click({
      selector: cfg.selectors.spin,
      labels: cfg.labels.spin,
      timeoutMs,
    });
    if (!clicked.ok) {
      throw new Error(
        "No encontre el boton de giro. Usa slots_discover para ver los elementos y define selectors.spin en slots.config.json.",
      );
    }

    const res = responsePromise ? await responsePromise : null;
    const balanceChanged = await this.waitForBalanceChange(before.balance.value, Math.min(timeoutMs, 8000));
    await page.waitForTimeout(settleMs);

    const after = await this.readState();

    let network: NetEntry | null = null;
    let payload: { text: string; json?: unknown; kind?: string } | null = null;
    if (res) {
      network = this.netEntries.find((e) => e.url === res.url() && e.status === res.status()) ?? null;
      if (network) {
        payload = await this.bodyFor(network.id, 6000);
      } else {
        try {
          const buf = await res.body();
          const view = describeBuffer("response", buf, res.headers()["content-type"] ?? null, {
            maxChars: 6000,
            includeRaw: false,
            maxRawBytes: 0,
          });
          payload = {
            text: view.text ?? `[${view.kind} ${view.bytes} B]`,
            json: view.json,
            kind: view.kind,
          };
        } catch {
          payload = null;
        }
      }
    }

    const moneyFields = payload?.json ? extractMoneyFields(payload.json) : {};
    const delta =
      before.balance.value != null && after.balance.value != null
        ? Number((after.balance.value - before.balance.value).toFixed(2))
        : null;

    return {
      before,
      after,
      delta,
      clicked: { ok: clicked.ok, desc: clicked.desc, method: clicked.method },
      network,
      payload,
      moneyFields,
      balanceChanged,
      durationMs: Date.now() - started,
    };
  }

  async setBet(opts: {
    amount?: number;
    increments?: number;
    direction?: "up" | "down";
  }): Promise<{ before: SlotState; after: SlotState; steps: number; ok: boolean }> {
    const cfg = loadConfig();
    const before = await this.readState();
    const target = opts.amount ?? null;
    const direction = opts.direction ?? (opts.increments && opts.increments < 0 ? "down" : "up");
    const maxSteps = Math.abs(opts.increments ?? 20);

    let steps = 0;
    for (let i = 0; i < maxSteps; i++) {
      const state = await this.readState();
      if (target != null && state.bet.value != null && Math.abs(state.bet.value - target) < 0.005) break;
      const isUp = target != null && state.bet.value != null ? state.bet.value < target : direction === "up";
      const clicked = await this.click({
        selector: isUp ? cfg.selectors.betIncrease : cfg.selectors.betDecrease,
        labels: isUp ? cfg.labels.betIncrease : cfg.labels.betDecrease,
        timeoutMs: 3000,
      });
      if (!clicked.ok) break;
      steps++;
      await this.page?.waitForTimeout(120);
      const afterClick = await this.readState();
      if (afterClick.bet.value != null && state.bet.value != null && afterClick.bet.value === state.bet.value) {
        break; // tope alcanzado
      }
    }

    const after = await this.readState();
    const ok =
      target != null ? after.bet.value != null && Math.abs(after.bet.value - target) < 0.005 : true;
    return { before, after, steps, ok };
  }

  async screenshot(opts: { selector?: string; fullPage?: boolean; save?: boolean }): Promise<{
    path: string | null;
    base64: string;
  }> {
    const page = this.ensurePage();
    const cfg = loadConfig();
    const selector = opts.selector ?? cfg.selectors.canvas;
    let buf: Buffer;
    if (selector) {
      const found = await this.find({ selector, timeoutMs: 3000 });
      buf = found
        ? await found.locator.screenshot({ type: "png" })
        : await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
    } else {
      buf = await page.screenshot({ type: "png", fullPage: opts.fullPage ?? false });
    }

    let filePath: string | null = null;
    if (opts.save !== false) {
      filePath = artifactPath(cfg.artifactsDir, "screenshot", "png");
      const fs = await import("node:fs");
      fs.writeFileSync(filePath, buf);
    }
    return { path: filePath, base64: buf.toString("base64") };
  }

  async discover(): Promise<{
    frames: Array<{ url: string; name: string; isMain: boolean }>;
    elements: Array<Record<string, unknown>>;
    hints: Array<Record<string, unknown>>;
  }> {
    const page = this.ensurePage();
    const frames = page.frames();
    const elements: Array<Record<string, unknown>> = [];
    const hints: Array<Record<string, unknown>> = [];

    for (const frame of frames) {
      try {
        const found = await frame.evaluate(() => {
          const cssPath = (el: Element): string => {
            if (el.id) return `#${CSS.escape(el.id)}`;
            const parts: string[] = [];
            let cur: Element | null = el;
            for (let d = 0; d < 5 && cur && cur !== document.body; d++) {
              let part = cur.tagName.toLowerCase();
              if (cur.id) {
                parts.unshift(`#${CSS.escape(cur.id)}`);
                break;
              }
              const cls = (cur.getAttribute("class") ?? "")
                .trim()
                .split(/\s+/)
                .filter(Boolean)
                .slice(0, 2);
              if (cls.length) part += "." + cls.map((c) => CSS.escape(c)).join(".");
              const parent: Element | null = cur.parentElement;
              if (parent) {
                const sibs = Array.from(parent.children).filter((s) => s.tagName === cur!.tagName);
                if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
              }
              parts.unshift(part);
              cur = parent;
            }
            return parts.join(" > ");
          };

          const out: Array<Record<string, unknown>> = [];
          const nodes = document.querySelectorAll(
            'button, [role="button"], a, input, select, canvas, iframe, [data-testid], [class*="spin"], [class*="bet"], [class*="balance"]',
          );
          const seen = new Set<Element>();
          for (const el of Array.from(nodes)) {
            if (seen.has(el)) continue;
            seen.add(el);
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            const visible =
              rect.width > 2 &&
              rect.height > 2 &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              Number(style.opacity || "1") > 0.05;
            if (!visible) continue;
            const html = el as HTMLElement;
            out.push({
              tag: el.tagName.toLowerCase(),
              type: (el as HTMLInputElement).type ?? undefined,
              role: el.getAttribute("role") ?? undefined,
              id: el.id || undefined,
              cls: (el.getAttribute("class") ?? "").slice(0, 120) || undefined,
              testid: el.getAttribute("data-testid") ?? undefined,
              ariaLabel: el.getAttribute("aria-label") ?? undefined,
              name: el.getAttribute("name") ?? undefined,
              text: (html.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
              value: (el as HTMLInputElement).value?.slice(0, 40) || undefined,
              selector: cssPath(el).slice(0, 160),
              box: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              },
            });
            if (out.length >= 180) break;
          }

          // Pistas: nodos hoja cuyo texto huele a saldo/apuesta/ganancia.
          const keyword = /(balance|saldo|cr[eé]dito|apuesta|bet|stake|ganancia|premio|win|payout)/i;
          const hintOut: Array<Record<string, unknown>> = [];
          for (const el of Array.from(document.querySelectorAll("body *"))) {
            if (hintOut.length >= 40) break;
            const html = el as HTMLElement;
            const txt = (html.innerText ?? "").replace(/\s+/g, " ").trim();
            if (!txt || txt.length > 48 || !keyword.test(txt)) continue;
            if (el.children.length > 1) continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 4 || rect.height < 4) continue;
            const sib = el.nextElementSibling as HTMLElement | null;
            const sibText = sib ? (sib.innerText ?? "").replace(/\s+/g, " ").trim() : "";
            hintOut.push({
              text: txt,
              tag: el.tagName.toLowerCase(),
              id: el.id || undefined,
              cls: (el.getAttribute("class") ?? "").slice(0, 100) || undefined,
              selector: cssPath(el).slice(0, 160),
              sibling:
                sib && sibText && sibText.length <= 32
                  ? { text: sibText, selector: cssPath(sib).slice(0, 160) }
                  : undefined,
              box: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                w: Math.round(rect.width),
                h: Math.round(rect.height),
              },
            });
          }
          return { out, hintOut };
        });
        elements.push(...found.out.map((e) => ({ ...e, frame: frame.url().slice(0, 180) })));
        hints.push(...found.hintOut.map((e) => ({ ...e, frame: frame.url().slice(0, 180) })));
      } catch {
        /* frame no accesible */
      }
    }

    return {
      frames: frames.map((f) => ({
        url: f.url(),
        name: f.name(),
        isMain: f === page.mainFrame(),
      })),
      elements,
      hints,
    };
  }

  async wait(opts: {
    ms?: number;
    selector?: string;
    urlIncludes?: string;
    networkIdle?: boolean;
  }): Promise<{ waitedMs: number; matched: string }> {
    const page = this.ensurePage();
    const started = Date.now();
    let matched = "tiempo";

    if (opts.selector) {
      const found = await this.find({ selector: opts.selector, timeoutMs: opts.ms ?? 15000 });
      matched = found ? "selector" : "timeout-esperando-selector";
    } else if (opts.urlIncludes) {
      await page
        .waitForURL((u) => u.toString().includes(opts.urlIncludes!), { timeout: opts.ms ?? 15000 })
        .catch(() => undefined);
      matched = "url";
    } else if (opts.networkIdle) {
      await page.waitForLoadState("networkidle", { timeout: opts.ms ?? 15000 }).catch(() => undefined);
      matched = "networkidle";
    } else {
      await page.waitForTimeout(opts.ms ?? 1000);
    }

    return { waitedMs: Date.now() - started, matched };
  }

  async startTrace(): Promise<string> {
    const ctx = this.context;
    if (!ctx) throw new Error("No hay contexto de navegador. Llama a slots_open primero.");
    if (this.tracing) throw new Error("Ya hay una traza en curso.");
    await ctx.tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.tracing = true;
    return "traza iniciada";
  }

  async stopTrace(): Promise<{ path: string }> {
    const ctx = this.context;
    if (!ctx || !this.tracing) throw new Error("No hay traza en curso.");
    const cfg = loadConfig();
    const file = artifactPath(cfg.artifactsDir, "trace", "zip");
    await ctx.tracing.stop({ path: file });
    this.tracing = false;
    return { path: file };
  }

  async close(): Promise<void> {
    try {
      if (this.attachedViaCdp) {
        await this.browser?.close();
      } else {
        await this.context?.close();
        await this.browser?.close();
      }
    } catch {
      /* ignore */
    }
    this.browser = null;
    this.context = null;
    this.page = null;
    this.attachedViaCdp = false;
    this.tracing = false;
  }
}

// ---------------------------------------------------------------- helpers

function slugify(text: string): string {
  const base = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 28);
  return base;
}

/** Rejilla de recortes con fondo oscuro; sin texto (el orden lo da la respuesta). */
function composeMontage(crops: Buffer[], cellW = 200, cellH = 96, cols = 0, gap = 8): Buffer {
  const columns = cols || Math.min(4, Math.max(1, crops.length));
  const rows = Math.ceil(crops.length / columns);
  const out = new PNG({
    width: columns * cellW + (columns + 1) * gap,
    height: rows * cellH + (rows + 1) * gap,
  });
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 11;
    out.data[i + 1] = 16;
    out.data[i + 2] = 32;
    out.data[i + 3] = 255;
  }

  crops.forEach((buf, index) => {
    let src: PNG;
    try {
      src = PNG.sync.read(buf);
    } catch {
      return;
    }
    const col = index % columns;
    const row = Math.floor(index / columns);
    const ox = gap + col * (cellW + gap);
    const oy = gap + row * (cellH + gap);
    const scale = Math.min(cellW / src.width, cellH / src.height, 1);
    const dw = Math.max(1, Math.round(src.width * scale));
    const dh = Math.max(1, Math.round(src.height * scale));
    const dx = ox + Math.floor((cellW - dw) / 2);
    const dy = oy + Math.floor((cellH - dh) / 2);

    for (let y = 0; y < dh; y++) {
      const sy = Math.min(src.height - 1, Math.floor(y / scale));
      for (let x = 0; x < dw; x++) {
        const sx = Math.min(src.width - 1, Math.floor(x / scale));
        const si = (sy * src.width + sx) << 2;
        const di = ((dy + y) * out.width + (dx + x)) << 2;
        out.data[di] = src.data[si]!;
        out.data[di + 1] = src.data[si + 1]!;
        out.data[di + 2] = src.data[si + 2]!;
        out.data[di + 3] = 255;
      }
    }
  });

  return PNG.sync.write(out);
}

/** IDs canonicos para el mapa del motor (Cocos): nombre primero, luego componentes. */
function canvasIdFor(hit: CanvasHit, cfg: SlotsConfig): string | null {
  const name = hit.name;
  const comps = hit.comps.join(" ");
  const both = `${name} ${comps}`;

  // El nombre desambigua: hay proveedores que usan el mismo componente para +/-.
  if (/plus|increase/i.test(name)) return "bet-up";
  if (/minus|decrease/i.test(name)) return "bet-down";

  const rules: Array<[RegExp, string]> = [
    [/(TurboSpin|Turbo)/i, "turbo"],
    [/(AutoSpin|AutoPlay|auto[_-]?spin|auto[_-]?play)/i, "autoplay"],
    [/(MaxBet|max[_-]?bet)/i, "max-bet"],
    [/(BetOption|bet[_-]?option)/i, "bet-options"],
    [/(SpinOption|spin[_-]?option)/i, "spin-options"],
    [/(BuyFeature|FeatureBuy|buy[_-]?feature|buy[_-]?bonus|feature[_-]?buy)/i, "buy-bonus"],
    [/(WalletNavigate|CashWallet|Wallet)/i, "wallet"],
    [/(Payout|Paytable)/i, "payout"],
    [/(Confirm)/i, "confirm"],
    [/(Setting|MenuIcon)/i, "settings"],
    [/(ReturnLobby|return[_-]?lobby|back[_-]?btn|close|exit)/i, "back"],
    [/(SpinButton|spin[_-]?button|spin[_-]?btn|SpinButtonView)/i, "spin"],
    [/(Info|Help|Rules)/i, "info"],
    [/(Start|Play|Continue)/i, "start"],
  ];
  for (const [re, id] of rules) if (re.test(both)) return id;
  // BetModifier sin plus/minus en el nombre: ambiguo, mejor el slug del nodo.
  if (/BetModifier/i.test(comps)) return null;
  // Ultimo recurso: canonico por texto (buy/bonus/confirm) del mapa DOM.
  return canonicalId(name.replace(/[_-]+/g, " "), cfg);
}

/** Normaliza un cuerpo HTTP a algo inspeccionable: JSON, texto o binario (base64/hex). */
function describeBuffer(
  side: "request" | "response",
  buf: Buffer,
  contentType: string | null,
  opts: { maxChars: number; includeRaw: boolean; maxRawBytes: number },
): BodyView {
  const bytes = buf.length;
  if (!bytes) return { side, bytes: 0, contentType, kind: "empty", truncated: false };

  const ct = (contentType ?? "").toLowerCase();
  const asText = buf.toString("utf8");
  const invalid = (asText.match(/\uFFFD/g) ?? []).length;
  const lookedJson = asText.trimStart().startsWith("{") || asText.trimStart().startsWith("[");
  const parsed = safeJsonParse(asText);
  const textual = /json|text|xml|javascript|x-www-form-urlencoded|graphql|html/i.test(ct);

  const kind: BodyView["kind"] =
    parsed !== undefined ? "json" : textual || (lookedJson && invalid / bytes < 0.02) || invalid / bytes < 0.02 ? "text" : "binary";

  const view: BodyView = { side, bytes, contentType, kind, truncated: false };

  if (kind === "json") view.json = parsed;

  if (kind === "binary" || opts.includeRaw) {
    const slice = Math.min(opts.maxRawBytes, bytes);
    view.base64 = buf.subarray(0, slice).toString("base64");
    view.hex = buf.subarray(0, Math.min(256, bytes)).toString("hex");
    if (bytes > slice) view.truncated = true;
  }

  if (kind !== "binary") {
    if (asText.length > opts.maxChars) {
      view.text = truncate(asText, opts.maxChars);
      view.truncated = true;
    } else {
      view.text = asText;
    }
  } else {
    view.note = `binario ${bytes} B (${contentType ?? "sin content-type"}): usa base64/hex`;
  }

  return view;
}

/** IDs canonicos para que el mapa sea reutilizable entre proveedores e idiomas. */
function canonicalId(label: string, cfg: SlotsConfig): string | null {
  const l = label.toLowerCase().trim();
  const matches = (list: string[]): boolean =>
    list.some((candidate) => {
      const c = candidate.toLowerCase().trim();
      if (!c) return false;
      return c.length <= 2 ? l === c : l.includes(c);
    });

  if (matches(cfg.labels.spin)) return "spin";
  if (matches(cfg.labels.betIncrease)) return "bet-up";
  if (matches(cfg.labels.betDecrease)) return "bet-down";
  if (/(comprar|compra|buy|bonus)/i.test(l)) return "buy-bonus";
  if (matches(cfg.labels.confirm)) return "confirm";
  return null;
}

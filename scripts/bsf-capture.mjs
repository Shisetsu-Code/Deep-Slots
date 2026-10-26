// Captura completa de una sesion de Super Golf Drive (PG Soft demo):
// endpoints, request/response crudos (base64/hex/JSON), WebSockets y mapa de UI del motor Cocos.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, ".slots-artifacts", "bsf");
fs.mkdirSync(outDir, { recursive: true });

const GAME_URL = "https://public.pg-demo.com/demo/?gi=1513328&lang=en";
const SPIN_COUNT = 2;

const entries = [];
const byKey = new Map();
const sockets = [];

function safeJson(buf) {
  try {
    const t = buf.toString("utf8");
    if (!/^[\s]*[{[]/.test(t)) return null;
    return JSON.parse(t);
  } catch {
    return null;
  }
}
function printable(buf) {
  const t = buf.toString("utf8");
  const bad = (t.match(/\uFFFD/g) || []).length;
  return bad / Math.max(1, t.length) < 0.02 ? t : null;
}

const browser = await chromium.launch({ channel: process.env.SLOTS_CHANNEL || "msedge", headless: false, args: ["--window-size=1440,960"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await context.newPage();

page.on("websocket", (ws) => {
  const rec = { url: ws.url(), frames: [] };
  sockets.push(rec);
  ws.on("framesent", (f) => rec.frames.push({ dir: "sent", t: Date.now(), payload: String(f.payload).slice(0, 4000) }));
  ws.on("framereceived", (f) => rec.frames.push({ dir: "recv", t: Date.now(), payload: String(f.payload).slice(0, 4000) }));
});

page.on("request", (req) => {
  const key = `${req.method()} ${req.url()}#${Date.now()}`;
  const rec = {
    id: entries.length + 1,
    t: new Date().toISOString(),
    method: req.method(),
    url: req.url(),
    resourceType: req.resourceType(),
    reqHeaders: req.headers(),
  };
  try {
    const buf = req.postDataBuffer();
    if (buf && buf.length) {
      rec.reqBytes = buf.length;
      rec.reqBase64 = buf.toString("base64");
      rec.reqHex = buf.subarray(0, 64).toString("hex");
      rec.reqText = printable(buf);
      rec.reqJson = safeJson(buf);
    }
  } catch {}
  entries.push(rec);
  byKey.set(key, rec);
  rec.__key = key;
});

page.on("response", async (res) => {
  const req = res.request();
  const rec = entries.find((e) => e.url === req.url() && e.method === req.method() && !e.status);
  if (!rec) return;
  rec.status = res.status();
  rec.resHeaders = res.headers();
  if (!["xhr", "fetch", "document", "script"].includes(req.resourceType())) return;
  try {
    const buf = await res.body();
    rec.resBytes = buf.length;
    rec.resBase64 = buf.toString("base64").slice(0, 400000);
    rec.resHex = buf.subarray(0, 64).toString("hex");
    rec.resText = printable(buf)?.slice(0, 20000) ?? null;
    rec.resJson = safeJson(buf) ?? undefined;
    rec.resType = rec.resJson ? "json" : rec.resText ? "text" : "binary";
  } catch (e) {
    rec.resError = String(e).slice(0, 120);
  }
});

async function clickText(text, timeout = 6000) {
  const el = page.getByText(text, { exact: false }).first();
  try {
    await el.waitFor({ state: "visible", timeout });
    await el.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function canvasPoint(fx, fy) {
  const box = await page.locator("#GameCanvas").boundingBox();
  if (!box) throw new Error("canvas no encontrado");
  return { x: Math.round(box.x + box.width * fx), y: Math.round(box.y + box.height * fy) };
}

await page.goto(GAME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
await clickText("Continue to Game");
await page.waitForTimeout(5000);

// splash -> GET STARTED (canvas)
const start = await canvasPoint(0.5, 0.785);
await page.mouse.click(start.x, start.y);
await page.waitForTimeout(9000);

// mapa de UI del motor
const uiMap = await page.evaluate(() => {
  const cc = window.cc;
  if (!cc) return { error: "cc no disponible" };
  const out = [];
  const walk = (n) => {
    try {
      if (n.activeInHierarchy) {
        const s = n.getContentSize ? n.getContentSize() : { width: 0, height: 0 };
        if (s.width > 40 && s.height > 40 && /button|btn|menu|spin|bet|wallet|auto|turbo|return|buy/i.test(n.name)) {
          const p = n.convertToWorldSpaceAR(cc.v2(0, 0));
          out.push({
            name: n.name,
            wx: Math.round(p.x),
            wy: Math.round(p.y),
            w: Math.round(s.width),
            h: Math.round(s.height),
            comps: (n._components || []).map((c) => c && c.__classname__).filter(Boolean).join(","),
          });
        }
      }
    } catch (e) {}
    (n.children || []).forEach(walk);
  };
  walk(cc.director.getScene());
  const rect = document.getElementById("GameCanvas").getBoundingClientRect();
  const scale = cc.view.getScaleX();
  return {
    canvas: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    design: cc.view.getDesignResolutionSize(),
    scale,
    nodes: out.map((e) => ({
      ...e,
      x: Math.round(rect.x + e.wx * scale),
      y: Math.round(rect.y + rect.height - e.wy * scale),
      sw: Math.round(e.w * scale),
      sh: Math.round(e.h * scale),
    })),
  };
});

const before = entries.length;
const marks = [];

for (let i = 0; i < SPIN_COUNT; i++) {
  const p = await canvasPoint(0.5, 0.896);
  const t0 = entries.length;
  await page.mouse.click(p.x, p.y);
  marks.push({ spin: i + 1, at: new Date().toISOString(), point: p, firstRequest: t0 });
  await page.waitForTimeout(7000);
}

await page.waitForTimeout(3000);
await page.screenshot({ path: path.join(outDir, "final.png") });

const state = await page.evaluate(() => {
  const cc = window.cc;
  let f = null;
  const walk = (n) => {
    try {
      const c = (n._components || []).find((x) => x && x.__classname__ === "SettingInfoFooterController");
      if (c && !f) f = c;
    } catch (e) {}
    (n.children || []).forEach(walk);
  };
  if (cc) walk(cc.director.getScene());
  const labels = {};
  const walk2 = (n) => {
    try {
      const l = n.getComponent && n.getComponent(cc.Label);
      if (l && n.activeInHierarchy && l.string && ["BalanceValue", "bet_amount_value", "WinCashValue"].includes(n.name)) labels[n.name] = l.string;
    } catch (e) {}
    (n.children || []).forEach(walk2);
  };
  if (cc) walk2(cc.director.getScene());
  return { model: f ? { balance: f.currentBalance, target: f.targetBalance, win: f.winBalance } : null, labels };
});

const interesting = entries.filter((e) => e.method !== "GET" || /api|game|wallet|spin/i.test(e.url));
const payload = {
  capturedAt: new Date().toISOString(),
  game: "Super Golf Drive (PG Soft)",
  url: GAME_URL,
  finalUrl: page.url(),
  uiMap,
  state,
  marks,
  sockets,
  requests: interesting,
  allRequestCount: entries.length,
};
fs.writeFileSync(path.join(outDir, "session.json"), JSON.stringify(payload, null, 2), "utf8");
console.log(JSON.stringify({ ok: true, requests: interesting.length, sockets: sockets.length, state, file: path.join(outDir, "session.json") }, null, 2));

await browser.close();

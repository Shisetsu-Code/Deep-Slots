// Diagnostico con el MCP: por que el giro no dispara tras cargar el juego.
// Reproduce el flujo del e2e y luego vuelca el estado interno del boton de giro.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = "https://public.pg-demo.com/demo/?gi=1513328&lang=en";
const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] != null));
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "pipe", env });
transport.stderr?.on("data", (d) => {
  const s = String(d);
  if (/listo|error/i.test(s)) process.stderr.write(`[server] ${s}`);
});
const client = new Client({ name: "mcp-stuck", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

let shotIndex = 0;
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  for (const c of res.content ?? []) {
    if (c.type === "image") {
      const dir = path.join(root, ".slots-artifacts", "stuck");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${shotIndex++}-${name}.png`), Buffer.from(c.data, "base64"));
    }
  }
  return text;
}
const evalJs = async (expression) => {
  const t = await call("slots_eval", { expression });
  // slots_eval devuelve JSON con el resultado ya serializado como string.
  try {
    const outer = JSON.parse(t.slice(t.indexOf("{")));
    let value = outer.value;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value);
      } catch {
        /* string plano */
      }
    }
    return value;
  } catch {
    return t;
  }
};

const stateExpr = `(() => {
  const cc = window.cc;
  if (!cc || !cc.director) return { engine: false };
  const scene = cc.director.getScene();
  let footer = null;
  let spinCtrl = null;
  const buttons = [];
  const walk = (n) => {
    (n._components || []).forEach((c) => {
      if (!c) return;
      const cls = c.__classname__ || "";
      if (cls === "SettingInfoFooterController") footer = c;
      if (cls === "SpinButtonViewController") spinCtrl = c;
      if (cls === "cc.Button" && /spin/i.test(n.name)) buttons.push({ node: n.name, interactable: c.interactable, enabled: c.enabled });
    });
    (n.children || []).forEach(walk);
  };
  walk(scene);
  const pick = (o, re) => {
    if (!o) return null;
    const out = {};
    for (const k of Object.keys(o)) {
      if (re.test(k)) {
        const v = o[k];
        if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") out[k] = v;
      }
    }
    return out;
  };
  return {
    engine: true,
    hidden: document.hidden,
    paused: cc.game && cc.game.isPaused ? cc.game.isPaused() : null,
    directorPaused: cc.director.isPaused ? cc.director.isPaused() : null,
    footer: pick(footer, /balance|win|bet|spin|auto|free|state|enable|lock|busy|flag|mode|tutorial|intro/i),
    spinCtrl: pick(spinCtrl, /spin|state|enable|lock|busy|auto|free|idle|ready|disable|interact/i),
    buttons,
    topNodes: (scene.children || []).map((c) => c.name),
    canvasChildren: ((scene.getChildByName && scene.getChildByName("Canvas") ? scene.getChildByName("Canvas").children : []) || []).map((c) => ({
      name: c.name,
      active: c.activeInHierarchy,
    })),
  };
})()`;

const hitExpr = (x, y) => `(() => {
  const els = document.elementsFromPoint(${x}, ${y}).slice(0, 4);
  return els.map((e) => ({ tag: e.tagName, cls: (e.className || "").toString().slice(0, 40), pe: getComputedStyle(e).pointerEvents }));
})()`;

try {
  await call("slots_open", { url });
  await call("slots_wait", { ms: 7000 });
  for (let i = 0; i < 6; i++) {
    await call("slots_click_at", { x: 720, y: 583 });
    await call("slots_wait", { ms: 3000 });
  }
  for (let i = 0; i < 30; i++) {
    const probe = JSON.parse((await call("slots_probe", { treeDepth: 0 })).slice((await call("slots_probe", { treeDepth: 0 })).indexOf("{")));
    if (probe.sceneNodes > 300 && typeof probe.state?.balance === "number") break;
    await call("slots_wait", { ms: 2000 });
  }
  await call("slots_click_at", { x: 620, y: 700 });
  await call("slots_wait", { ms: 5000 });

  console.log("estado tras intro:", JSON.stringify(await evalJs(stateExpr), null, 2));
  console.log("hit (720,801):", JSON.stringify(await evalJs(hitExpr(720, 801))));
  console.log("hit (720,690):", JSON.stringify(await evalJs(hitExpr(720, 690))));
  console.log("hit (720,583):", JSON.stringify(await evalJs(hitExpr(720, 583))));
  await call("slots_screenshot", {});

  // Prueba A: click en infoboard + spin (como attract-debug).
  for (let i = 0; i < 3; i++) {
    await call("slots_click_at", { x: 720, y: 690 });
    await call("slots_wait", { ms: 2000 });
    const before = (await call("slots_network", { urlPattern: "/v4/Spin", limit: 5 })).length;
    const click = await call("slots_click_id", { id: "spin", waitForNetwork: "/v4/Spin", settleMs: 3000 });
    console.log(`A${i + 1}:`, click.split("\n").slice(1, 6).join(" ").slice(0, 300), "| netLen", before);
    await call("slots_wait", { ms: 2000 });
  }
  console.log("estado tras A:", JSON.stringify(await evalJs(stateExpr), null, 2));
  await call("slots_screenshot", {});
  console.log("spins:", (await call("slots_network", { urlPattern: "/v4/Spin" })).slice(0, 600));
} catch (err) {
  console.log("ERR", String(err).slice(0, 500));
} finally {
  await call("slots_close").catch(() => undefined);
  await client.close();
}

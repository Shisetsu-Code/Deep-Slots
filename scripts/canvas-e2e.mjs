// E2E de las herramientas de motor: slots_probe + slots_canvas_map + captura de
// cuerpos binarios en slots_network. Corre contra el demo real de Super Golf Drive.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const url = process.argv[2] || "https://public.pg-demo.com/demo/?gi=1513328&lang=en";

const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] != null));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  stderr: "pipe",
  env,
});
transport.stderr?.on("data", (d) => {
  const s = String(d);
  if (/listo|error/i.test(s)) process.stderr.write(`[server] ${s}`);
});
const client = new Client({ name: "canvas-e2e", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

const images = [];
async function call(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  for (const c of res.content ?? []) if (c.type === "image") images.push({ name, data: c.data });
  if (res.isError) console.log(`!! ${name} -> ${text.slice(0, 900)}`);
  return { text, res };
}
function parseJsonish(text) {
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`sin JSON:\n${text.slice(0, 400)}`);
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error(`JSON incompleto:\n${text.slice(start, start + 300)}`);
}
const parse = (label, text) => parseJsonish(text);
const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "OK  " : "FAIL"} ${name}${detail ? ` -> ${detail}` : ""}`);
}

try {
  await call("slots_open", { url });

  // 1) Gate de dispositivo: sin esto el motor no arranca.
  await call("slots_wait", { ms: 7000 });
  for (let i = 0; i < 6; i++) {
    await call("slots_click_at", { x: 720, y: 583 });
    await call("slots_wait", { ms: 3000 });
  }

  // 2) Esperar a que la escena del juego este cargada (poll con slots_probe).
  let ready = null;
  for (let i = 0; i < 30; i++) {
    try {
      const t = (await call("slots_probe", { treeDepth: 0 })).text;
      const p = parse("slots_probe", t);
      if (p.sceneNodes > 300 && typeof p.state?.balance === "number") {
        ready = p;
        break;
      }
    } catch {
      /* navegacion/redirect en curso: reintentar */
    }
    await call("slots_wait", { ms: 2000 });
  }
  check("espera: escena cargada", !!ready, ready ? `${ready.sceneNodes} nodos, saldo ${ready.state?.balance}` : "timeout");

  // 3) Cerrar la intro (GET STARTED). (720,706) pisa el sello PG (720,720): usamos (620,700).
  await call("slots_click_at", { x: 620, y: 700 });
  await call("slots_wait", { ms: 5000 });
  await call("slots_screenshot", {});

  // ---------------------------------------------------------- slots_probe
  const probe = parse("slots_probe", (await call("slots_probe", { treeDepth: 1 })).text);
  console.log("\nprobe:", JSON.stringify({
    engine: probe.engine,
    version: probe.version,
    design: probe.design,
    scale: probe.scale,
    sceneNodes: probe.sceneNodes,
    state: probe.state,
    labels: probe.labels,
  }, null, 2));
  check("probe: motor cocos", probe.engine === "cocos2d", probe.version);
  check("probe: lee saldo", typeof probe.state?.balance === "number" && probe.state.balance > 0, `balance=${probe.state?.balance}`);
  check("probe: lee apuesta", typeof probe.state?.bet === "number" && probe.state.bet > 0, `bet=${probe.state?.bet}`);
  check("probe: escena", probe.sceneNodes > 100 && Array.isArray(probe.scene), `${probe.sceneNodes} nodos`);

  // ------------------------------------------------------ slots_canvas_map
  const map = parse("slots_canvas_map", (await call("slots_canvas_map", { screenshot: true })).text);
  const ids = (map.ids ?? []).map((e) => e.id);
  console.log("\ncanvas_map:", JSON.stringify({ engine: map.engine, calib: map.calibration, usables: map.usables, ids: map.ids }, null, 2));
  check("canvas_map: motor cocos", map.engine === "cocos2d");
  check("canvas_map: escala 0.46875", Math.abs((map.calibration?.scaleX ?? 0) - 0.46875) < 0.001, String(map.calibration?.scaleX));
  for (const need of ["spin", "bet-up", "bet-down", "turbo", "autoplay", "wallet"]) {
    check(`canvas_map: id ${need}`, ids.includes(need));
  }
  const spin = (map.ids ?? []).find((e) => e.id === "spin");
  check("canvas_map: spin centrado abajo", spin && Math.abs(spin.x + spin.w / 2 - 720) < 12 && spin.y + spin.h / 2 > 760, JSON.stringify(spin));

  // --------------------------------------------- slots_coords + click por ID
  const coordsText = (await call("slots_coords", {})).text;
  check("coords: persistidas", /"tag": "cocos"/.test(coordsText) && /"id": "spin"/.test(coordsText));

  // El aviso de carga es un DIV que tapa el canvas: esperar a que el canvas reciba el click.
  const isBlocked = async () => {
    const r = await call("slots_eval", { expression: "document.elementFromPoint(720,801)?.tagName" });
    return !/CANVAS/i.test(r.text);
  };
  let waited = 0;
  while ((await isBlocked()) && waited < 40) {
    await call("slots_wait", { ms: 2000 });
    waited += 2;
  }
  check("overlay de carga fuera", !(await isBlocked()), `${waited}s esperados`);

  let clickJson = null;
  await call("slots_eval", {
    expression: "window.__pd=0; document.addEventListener('pointerdown', () => window.__pd++, true); 'ok'",
  });
  for (let i = 0; i < 6; i++) {
    const click = await call("slots_click_id", { id: "spin", waitForNetwork: "/v4/Spin", settleMs: 2500 });
    clickJson = parse("slots_click_id", click.text);
    const pd = (await call("slots_eval", { expression: "window.__pd" })).text.match(/"value":\s*"?(\d+)/)?.[1];
    console.log(`  intento ${i + 1}: pointerdown=${pd} network=${clickJson.network?.url ?? "-"}`);
    if (clickJson.network) break;
    // El juego ignora clicks durante la presentacion de bienvenida: tocamos el infoboard.
    await call("slots_click_at", { x: 720, y: 690 });
    await call("slots_wait", { ms: 2000 });
  }
  console.log("\nclick_id spin:", JSON.stringify({ ok: clickJson?.ok, drift: clickJson?.drift, network: clickJson?.network }));
  check("click_id: giro por coordenada del mapa", clickJson?.ok && !!clickJson?.network, JSON.stringify(clickJson?.network));
  check("click_id: sin drift", clickJson?.drift === false);

  // ------------------------------------- red con cuerpos binarios exactos
  const net = parse(
    "slots_network",
    (await call("slots_network", {
      urlPattern: "/v4/Spin",
      includeBodies: true,
      bodySide: "both",
      raw: true,
      maxBodyChars: 400,
    })).text,
  );
  const spinBody = (net.bodies ?? []).find((b) => /\/v4\/Spin/.test(b.url));
  const rb = spinBody?.request;
  const sb = spinBody?.response;
  console.log("\nspin bodies:", JSON.stringify({
    request: rb && { bytes: rb.bytes, kind: rb.kind, ct: rb.contentType, hex: rb.hex?.slice(0, 48), b64: rb.base64?.slice(0, 32) },
    response: sb && { bytes: sb.bytes, kind: sb.kind, ct: sb.contentType, hex: sb.hex?.slice(0, 48), b64: sb.base64?.slice(0, 32) },
  }, null, 2));
  check("network: request binario capturado", rb?.kind === "binary" && rb.bytes > 20, `${rb?.bytes} B`);
  check("network: request con base64/hex", !!rb?.base64 && !!rb?.hex);
  check("network: response binaria capturada", sb?.kind === "binary" && sb.bytes > 200, `${sb?.bytes} B`);
  check("network: response con base64/hex", !!sb?.base64 && !!sb?.hex);

  // Verificacion por hex/base64 del body recibido vs estado del motor
  const probe2 = parse("slots_probe", (await call("slots_probe", { treeDepth: 0 })).text);
  check("probe: saldo cambia tras el giro", probe2.state?.balance !== probe.state?.balance,
    `${probe.state?.balance} -> ${probe2.state?.balance} (win ${probe2.state?.win})`);

  const exp = await call("slots_network_export", { urlPattern: "/v4/Spin|GameWallet", maxBodyChars: 2000 });
  const exportPath = /(.+\.json)/.exec(exp.text)?.[1]?.trim();
  const dump = exportPath ? JSON.parse(fs.readFileSync(exportPath, "utf8")) : null;
  const dumpSpin = (dump?.requests ?? []).find((r) => /\/v4\/Spin/.test(r.url) && r.response);
  check("network_export: volcado con request+response", !!dumpSpin?.response?.base64 && !!dumpSpin?.request?.base64, exportPath);

  await call("slots_wait", { ms: 500 });
} catch (err) {
  check("ejecucion sin excepciones", false, String(err).slice(0, 400));
} finally {
  const dir = path.join(root, ".slots-artifacts", "e2e");
  fs.mkdirSync(dir, { recursive: true });
  images.forEach((img, i) =>
    fs.writeFileSync(path.join(dir, `${i}-${img.name}.png`), Buffer.from(img.data, "base64")),
  );
  await call("slots_close").catch(() => undefined);
  await client.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} comprobaciones OK`);
  process.exit(failed.length ? 1 : 0);
}

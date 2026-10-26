// Diagnostico: donde clickear para salir de la intro sin abrir el sello de verificacion.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
const net = [];
page.on("request", (r) => {
  if (/\/v4\/Spin$/.test(r.url())) net.push(r.url());
});

await page.goto("https://public.pg-demo.com/demo/?gi=1513328&lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
await page.getByText("Continue to Game").first().click().catch(() => {});
await page.waitForTimeout(6000);

const bounds = () =>
  page.evaluate(() => {
    const cc = window.cc;
    const scene = cc.director.getScene();
    const rect = document.querySelector("canvas").getBoundingClientRect();
    const scale = cc.view.getScaleX();
    const toScreen = (bb) => ({
      x: Math.round(rect.x + bb.x * scale),
      y: Math.round(rect.y + rect.height - (bb.y + bb.height) * scale),
      w: Math.round(bb.width * scale),
      h: Math.round(bb.height * scale),
    });
    const out = [];
    const walk = (n) => {
      const lbl = n.getComponent && cc.Label ? n.getComponent(cc.Label) : null;
      const txt = lbl && typeof lbl.string === "string" ? lbl.string.trim() : "";
      if (txt && /start|play|continue/i.test(txt)) {
        const bb = n.getBoundingBoxToWorld();
        out.push({ name: n.name, text: txt, ...toScreen(bb) });
      }
      (n.children || []).forEach(walk);
    };
    walk(scene);
    return out;
  });

console.log("labels de inicio:", JSON.stringify(await bounds(), null, 2));

// Intento 1: click en zona neutra
await page.mouse.click(720, 500);
await page.waitForTimeout(3000);
await page.mouse.click(720, 802);
await page.waitForTimeout(5000);
console.log("tras click neutro + spin:", net.length, "spins");
await page.screenshot({ path: ".slots-artifacts/intro-a.png" });

// Intento 2: click en GET STARTED a la izquierda del sello de verificacion
if (!net.length) {
  await page.mouse.click(620, 700);
  await page.waitForTimeout(5000);
  await page.mouse.click(720, 802);
  await page.waitForTimeout(6000);
  console.log("tras click en start-izq + spin:", net.length, "spins");
  await page.screenshot({ path: ".slots-artifacts/intro-b.png" });
}

const footer = await page.evaluate(() => {
  const cc = window.cc;
  let f = null;
  const walk = (n) => {
    (n._components || []).forEach((c) => {
      if (c && c.__classname__ === "SettingInfoFooterController") f = c;
    });
    (n.children || []).forEach(walk);
  };
  walk(cc.director.getScene());
  return f ? { balance: f.currentBalance, bet: f.betAmount, win: f.winBalance } : null;
});
console.log("footer:", JSON.stringify(footer));
await browser.close();

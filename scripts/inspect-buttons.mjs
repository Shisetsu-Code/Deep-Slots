// Diagnostico: componentes reales de los botones de la barra inferior.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "es-ES" });
const page = await ctx.newPage();
await page.goto("https://public.pg-demo.com/demo/?gi=1513328&lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(7000);
await page.getByText("Continue to Game").first().click().catch(() => {});
for (let i = 0; i < 25; i++) {
  const n = await page.evaluate(() => {
    const cc = window.cc;
    if (!cc || !cc.director) return 0;
    let c = 0;
    const walk = (x) => { c++; (x.children || []).forEach(walk); };
    try { walk(cc.director.getScene()); } catch { return 0; }
    return c;
  }).catch(() => 0);
  if (n > 300) break;
  await page.waitForTimeout(2000);
}

const info = await page.evaluate(() => {
  const cc = window.cc;
  const out = [];
  const walk = (n, path) => {
    const full = path ? `${path}/${n.name}` : n.name;
    if (/ReturnLobby|AutoSpin|spin_button_controller|minus_bet|plus_bet/i.test(n.name)) {
      out.push({
        name: n.name,
        path: full,
        comps: (n._components || []).map((c) => c && c.__classname__).filter(Boolean),
      });
    }
    (n.children || []).forEach((c) => walk(c, full));
  };
  walk(cc.director.getScene(), "");
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();

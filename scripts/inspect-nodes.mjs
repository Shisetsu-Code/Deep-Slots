// Diagnostico: por que aparecen decenas de "payout_button" en el mapa del motor.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
await page.goto("https://public.pg-demo.com/demo/?gi=1513328&lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
await page.getByText("Continue to Game").first().click().catch(() => {});
await page.waitForTimeout(5000);
await page.mouse.click(720, 706);
await page.waitForTimeout(6000);
await page.mouse.click(720, 706);
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const cc = window.cc;
  const scene = cc.director.getScene();
  const nodes = [];
  const walk = (n, path) => {
    const full = path ? `${path}/${n.name}` : n.name;
    if (/^payout_button/.test(n.name)) nodes.push({ path: full, node: n });
    (n.children || []).forEach((c) => walk(c, full));
  };
  walk(scene, "");
  const first = nodes[0];
  const chain = [];
  if (first) {
    let cur = first.node;
    while (cur) {
      chain.push({
        name: cur.name,
        active: cur.active,
        activeInHierarchy: cur.activeInHierarchy,
        opacity: cur.opacity,
        scale: [cur.scaleX, cur.scaleY],
        pos: [Math.round(cur.x), Math.round(cur.y)],
        comps: (cur._components || []).map((c) => c && c.__classname__).filter(Boolean),
      });
      cur = cur.parent;
    }
  }
  return { payoutCount: nodes.length, firstPath: first?.path ?? null, chain };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: "..\\.slots-artifacts\\inspect.png" }).catch(() => {});
await browser.close();

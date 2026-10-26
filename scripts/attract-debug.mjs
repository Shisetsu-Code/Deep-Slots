// Diagnostico: por que el modo attract no acepta el giro.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
const spins = [];
page.on("request", (r) => {
  if (/\/v4\/Spin$/.test(r.url())) spins.push(Date.now());
});
const click = async (x, y, label) => {
  const before = spins.length;
  await page.mouse.click(x, y);
  await page.waitForTimeout(4000);
  console.log(`${label} (${x},${y}) -> spins +${spins.length - before}`);
  return spins.length - before;
};

await page.goto("https://public.pg-demo.com/demo/?gi=1513328&lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(7000);
await click(720, 583, "gate");

for (let i = 0; i < 20; i++) {
  const nodes = await page.evaluate(() => {
    const cc = window.cc;
    if (!cc || !cc.director) return 0;
    let n = 0;
    const walk = (x) => {
      n++;
      (x.children || []).forEach(walk);
    };
    try { walk(cc.director.getScene()); } catch { return 0; }
    return n;
  }).catch(() => 0);
  if (nodes > 300) break;
  await page.waitForTimeout(2000);
}

console.log("intro presente?", await page.evaluate(() => {
  const cc = window.cc;
  const scene = cc.director.getScene();
  let found = false;
  const walk = (n) => {
    const lbl = n.getComponent && cc.Label ? n.getComponent(cc.Label) : null;
    if (lbl && /get started|start/i.test(lbl.string || "") && n.activeInHierarchy) found = true;
    (n.children || []).forEach(walk);
  };
  walk(scene);
  return found;
}));

await page.screenshot({ path: ".slots-artifacts/attract-1.png" });
await click(720, 802, "spin directo");
await click(620, 401, "click zona reels");
await click(720, 802, "spin tras click reels");
await click(720, 690, "click infoboard");
await click(720, 802, "spin tras infoboard");
await page.keyboard.press("Space");
await page.waitForTimeout(3000);
console.log("space -> spins", spins.length);
await page.screenshot({ path: ".slots-artifacts/attract-2.png" });

const footer = await page.evaluate(() => {
  const cc = window.cc;
  let f = null;
  const walk = (n) => {
    (n._components || []).forEach((c) => { if (c && c.__classname__ === "SettingInfoFooterController") f = c; });
    (n.children || []).forEach(walk);
  };
  walk(cc.director.getScene());
  return f ? { balance: f.currentBalance, bet: f.betAmount } : null;
});
console.log("footer:", JSON.stringify(footer), "total spins:", spins.length);
await browser.close();

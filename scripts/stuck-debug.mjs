// Diagnostico: que elemento recibe el click sobre el boton de spin.
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
const net = [];
page.on("request", (r) => {
  if (/\/v4\/Spin$/.test(r.url())) net.push(Date.now());
});

await page.goto("https://public.pg-demo.com/demo/?gi=1513328&lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(7000);
for (let i = 0; i < 3; i++) {
  await page.mouse.click(720, 583);
  await page.waitForTimeout(3000);
}
for (let i = 0; i < 20; i++) {
  const nodes = await page.evaluate(() => {
    const cc = window.cc;
    if (!cc || !cc.director) return 0;
    let n = 0;
    const walk = (x) => {
      n++;
      (x.children || []).forEach(walk);
    };
    try {
      walk(cc.director.getScene());
    } catch {
      return 0;
    }
    return n;
  }).catch(() => 0);
  if (nodes > 300) break;
  await page.waitForTimeout(2000);
}

const stack = await page.evaluate(() => {
  const els = document.elementsFromPoint(720, 801).slice(0, 5);
  return els.map((e) => ({
    tag: e.tagName,
    id: e.id,
    cls: (e.className || "").toString().slice(0, 60),
    pe: getComputedStyle(e).pointerEvents,
    z: getComputedStyle(e).zIndex,
    txt: (e.innerText || "").replace(/\s+/g, " ").slice(0, 40),
  }));
});
console.log("elementos en (720,801):", JSON.stringify(stack, null, 2));

await page.mouse.click(620, 700);
await page.waitForTimeout(3000);
await page.mouse.click(720, 801);
await page.waitForTimeout(5000);
console.log("intento 1 spins:", net.length);
if (!net.length) {
  await page.mouse.click(620, 700);
  await page.waitForTimeout(2500);
  await page.mouse.click(720, 801);
  await page.waitForTimeout(5000);
  console.log("intento 2 spins:", net.length);
}
if (!net.length) {
  await page.mouse.click(720, 700);
  await page.waitForTimeout(2500);
  await page.mouse.click(720, 801);
  await page.waitForTimeout(5000);
  console.log("intento 3 (700 centro) spins:", net.length);
}
await page.screenshot({ path: ".slots-artifacts/stuck.png" });
await browser.close();

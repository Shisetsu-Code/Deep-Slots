// Diagnostico: por que el giro no responde en headless.
import { chromium } from "playwright-core";

const headless = process.env.HEADLESS !== "0";
const browser = await chromium.launch({ channel: "msedge", headless });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
const page = await ctx.newPage();
const net = [];
const errs = [];
page.on("request", (r) => {
  if (/Spin|GameWallet/i.test(r.url())) net.push(`${r.method()} ${r.url().slice(0, 90)}`);
});
page.on("console", (m) => {
  if (m.type() === "error") errs.push(m.text().slice(0, 160));
});

await page.goto("https://public.pg-demo.com/demo/?gi=1513328&lang=en", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(6000);
await page.getByText("Continue to Game").first().click().catch(() => {});
await page.waitForTimeout(6000);
for (let i = 0; i < 5; i++) {
  await page.mouse.click(720, 706);
  await page.waitForTimeout(2000);
}
await page.waitForTimeout(6000);

const state = async () =>
  page.evaluate(() => {
    const cc = window.cc;
    const scene = cc && cc.director.getScene();
    let footer = null;
    let spinCtrl = null;
    const walk = (n) => {
      (n._components || []).forEach((c) => {
        if (!c) return;
        if (c.__classname__ === "SettingInfoFooterController") footer = c;
        if (c.__classname__ === "SpinButtonViewController") spinCtrl = c;
      });
      (n.children || []).forEach(walk);
    };
    if (scene) walk(scene);
    const keys = (o) => (o ? Object.keys(o).filter((k) => !k.startsWith("__") && k !== "node").slice(0, 30) : []);
    return {
      hidden: document.hidden,
      paused: cc && cc.game && cc.game.isPaused ? cc.game.isPaused() : null,
      balance: footer && footer.currentBalance,
      bet: footer && footer.betAmount,
      win: footer && footer.winBalance,
      spinKeys: keys(spinCtrl),
      spinState: spinCtrl && (spinCtrl.state ?? spinCtrl._state),
      footerKeys: keys(footer),
    };
  });

console.log("estado inicial:", JSON.stringify(await state(), null, 2));

for (let i = 0; i < 3; i++) {
  const before = net.length;
  await page.mouse.click(720, 802);
  await page.waitForTimeout(6000);
  console.log(`click ${i + 1}: requests=${net.length - before}`, JSON.stringify(await state()));
  if (net.length > before) break;
}

await page.screenshot({ path: `.slots-artifacts/spin-debug-${headless ? "headless" : "headful"}.png` });
console.log("net:", net.slice(0, 8));
console.log("errores consola:", errs.slice(0, 6));
await browser.close();

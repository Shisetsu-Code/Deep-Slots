// Diagnostico 2: estado visual real de los payout_button.
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
  const out = [];
  const walk = (n, path) => {
    const full = path ? `${path}/${n.name}` : n.name;
    if (/^payout_button/.test(n.name) && out.length < 3) {
      const sprites = [];
      const collect = (x) => {
        (x._components || []).forEach((c) => {
          if (c && c.__classname__ === "cc.Sprite") {
            sprites.push({
              node: x.name,
              sf: c.spriteFrame && c.spriteFrame.name,
              enabled: c.enabled,
              sizeMode: c._sizeMode,
              color: c.color && [c.color.r, c.color.g, c.color.b, c.color.a],
            });
          }
        });
        (x.children || []).forEach(collect);
      };
      collect(n);
      const btn = n.getComponent && n.getComponent(cc.Button);
      out.push({
        path: full,
        active: n.active,
        opacity: n.opacity,
        color: [n.color.r, n.color.g, n.color.b, n.color.a],
        scale: [n.scaleX, n.scaleY],
        zIndex: n.zIndex,
        hasButton: !!btn,
        interactable: btn ? btn.interactable : null,
        children: (n.children || []).map((c) => c.name),
        sprites,
      });
    }
    (n.children || []).forEach((c) => walk(c, full));
  };
  walk(scene, "");
  return out;
});
console.log(JSON.stringify(info, null, 2));
await browser.close();

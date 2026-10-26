// Diagnostico 3: arbol de escena + preview del filtro "solo lo que se dibuja".
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

const tree = await page.evaluate(() => {
  const cc = window.cc;
  const scene = cc.director.getScene();
  const lines = [];
  const walk = (n, d) => {
    if (d > 2) return;
    lines.push(`${"  ".repeat(d)}${n.name}${n.activeInHierarchy ? "" : " [off]"}`);
    (n.children || []).forEach((c) => walk(c, d + 1));
  };
  walk(scene, 0);
  const drawable = (n) => {
    if (!n.activeInHierarchy) return false;
    const stack = [n];
    let guard = 0;
    while (stack.length && guard++ < 80) {
      const cur = stack.pop();
      if (cur.opacity < 8) continue;
      for (const c of cur._components || []) {
        if (!c || c.enabled === false) continue;
        const cls = c.__classname__ || "";
        if (cls === "cc.Sprite" && c.spriteFrame) return true;
        if ((cls === "cc.Label" || cls === "cc.RichText") && c.string) return true;
        if (cls === "cc.Graphics" || cls === "cc.ParticleSystem") return true;
        if (cls === "sp.Skeleton" && c.skeletonData) return true;
      }
      for (const k of cur.children || []) if (k.activeInHierarchy) stack.push(k);
    }
    return false;
  };
  const hits = [];
  const scan = (n, path) => {
    const full = path ? `${path}/${n.name}` : n.name;
    if (n.activeInHierarchy) {
      const comps = (n._components || []).map((c) => c && c.__classname__).filter(Boolean);
      const named = /btn|button|icon|menu|toggle|spin|bet|wallet|auto|turbo|buy|bonus|back|close|setting|info|payout|plus|minus|max|confirm|start|play/i.test(n.name);
      if (named || comps.includes("cc.Button")) {
        const s = n.getContentSize();
        if (s.width >= 18 && s.height >= 18) {
          hits.push({
            path: full,
            name: n.name,
            comps: comps.join(","),
            size: `${Math.round(s.width)}x${Math.round(s.height)}`,
            drawn: drawable(n),
          });
        }
      }
    }
    (n.children || []).forEach((c) => scan(c, full));
  };
  scan(scene, "");
  return { tree: lines, hits };
});

console.log(tree.tree.join("\n"));
console.log("\n--- candidatos:", tree.hits.length, " / dibujados:", tree.hits.filter((h) => h.drawn).length);
for (const h of tree.hits) console.log(`${h.drawn ? "SI" : "no"} ${h.name.padEnd(26)} ${h.size.padEnd(10)} ${h.comps}  <= ${h.path}`);
await browser.close();

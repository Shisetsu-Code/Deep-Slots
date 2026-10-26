import fs from "node:fs";
const d = JSON.parse(fs.readFileSync(new URL("../.slots-artifacts/bsf/session.json", import.meta.url), "utf8"));
const m = d.uiMap;
const keep = m.nodes
  .filter((n) => !/payout_button/.test(n.name))
  .map((n) => `${n.name.padEnd(26)} x=${String(n.x).padStart(4)} y=${String(n.y).padStart(3)}  ${n.sw}x${n.sh}  [${n.comps}]`);
console.log(JSON.stringify({ canvas: m.canvas, design: m.design, scale: m.scale }, null, 2));
console.log(keep.join("\n"));

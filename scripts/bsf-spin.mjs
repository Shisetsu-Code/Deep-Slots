import fs from "node:fs";
const p = new URL("../.slots-artifacts/bsf/session.json", import.meta.url);
const d = JSON.parse(fs.readFileSync(p, "utf8"));
const want = /game-api|GameWallet|Spin|GameInfo/;
const out = d.requests.filter((r) => want.test(r.url)).map((r) => ({
  id: r.id,
  method: r.method,
  url: r.url,
  status: r.status,
  reqBytes: r.reqBytes ?? 0,
  reqText: r.reqText,
  reqHex: r.reqHex,
  reqBase64: r.reqBase64 ? r.reqBase64.slice(0, 120) : null,
  resType: r.resType,
  resBytes: r.resBytes ?? 0,
  resHex: r.resHex,
  resJson: r.resJson ?? null,
  resText: r.resText ? r.resText.slice(0, 1200) : null,
  resBase64: r.resBase64 ? r.resBase64.slice(0, 160) : null,
}));
console.log(JSON.stringify(out, null, 2));

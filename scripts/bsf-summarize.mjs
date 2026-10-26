import fs from "node:fs";
const p = new URL("../.slots-artifacts/bsf/session.json", import.meta.url);
const d = JSON.parse(fs.readFileSync(p, "utf8"));
const out = [];
for (const r of d.requests) {
  if (r.method === "GET" && !/api|game|wallet|spin/i.test(r.url)) continue;
  out.push({
    id: r.id,
    method: r.method,
    url: r.url,
    status: r.status,
    type: r.resourceType,
    reqBytes: r.reqBytes ?? 0,
    reqJson: r.reqJson ?? null,
    reqText: r.reqText ? r.reqText.slice(0, 400) : null,
    reqHex: r.reqHex ?? null,
    resType: r.resType,
    resBytes: r.resBytes ?? 0,
    resJson: r.resJson ?? null,
    resText: r.resText ? r.resText.slice(0, 600) : null,
    resHex: r.resHex ?? null,
  });
}
console.log(JSON.stringify({ state: d.state, marks: d.marks, count: out.length, reqs: out }, null, 2).slice(0, 12000));

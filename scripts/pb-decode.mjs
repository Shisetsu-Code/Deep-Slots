// Decodificador generico de protobuf (wire format) para inspeccionar payloads sin .proto
import fs from "node:fs";

function readVarint(buf, i) {
  let shift = 0, val = 0;
  while (i < buf.length) {
    const b = buf[i++];
    val += (b & 0x7f) * Math.pow(2, shift);
    shift += 7;
    if (!(b & 0x80)) break;
  }
  return [val, i];
}

function tryMessage(buf, depth = 0) {
  const fields = [];
  let i = 0;
  try {
    while (i < buf.length) {
      const [key, ni] = readVarint(buf, i);
      i = ni;
      const field = Math.floor(key / 8);
      const wire = key % 8;
      if (field === 0 || field > 100000) return null;

      if (wire === 0) {
        let v;
        [v, i] = readVarint(buf, i);
        fields.push({ f: field, t: "varint", v });
      } else if (wire === 2) {
        let len;
        [len, i] = readVarint(buf, i);
        if (len > buf.length - i) return null;
        const sub = buf.subarray(i, i + len);
        i += len;
        const nested = depth < 5 ? tryMessage(sub, depth + 1) : null;
        const txt = sub.toString("utf8");
        const isText = nested === null && /^[\x20-\x7e]{1,80}$/.test(txt);
        fields.push(
          nested && nested.length
            ? { f: field, t: "msg", v: nested }
            : isText
              ? { f: field, t: "string", v: txt }
              : { f: field, t: "bytes", v: sub.toString("base64"), len: sub.length },
        );
      } else if (wire === 5) {
        fields.push({ f: field, t: "i32", v: buf.readUInt32LE(i) });
        i += 4;
      } else if (wire === 1) {
        fields.push({ f: field, t: "i64", v: buf.readBigUInt64LE(i).toString() });
        i += 8;
      } else {
        return null;
      }
    }
  } catch {
    return null;
  }
  return fields;
}

const session = JSON.parse(fs.readFileSync(new URL("../.slots-artifacts/bsf/session.json", import.meta.url), "utf8"));
const spins = session.requests.filter((r) => /\/v4\/Spin$/.test(r.url));
const target = process.argv[2] || "res";

for (const s of spins.slice(0, 1)) {
  const b64 = target === "req" ? s.reqBase64 : s.resBase64;
  const buf = Buffer.from(b64, "base64");
  const parsed = tryMessage(buf);
  console.log(JSON.stringify({ url: s.url, bytes: buf.length, target, fields: parsed }, null, 2).slice(0, 6000));
}

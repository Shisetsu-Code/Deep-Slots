const gameId = process.argv[2];
const clientVersion = process.argv[3];
const ecfVersion = process.argv[4] ?? '369146';
const omit = (process.argv[5] ?? '').split(',').filter(Boolean);
const url = `https://gc5-stage.contentmedia.eu/capi/${gameId}/play/init?gl=true&standalone=false&iframe=true`;
const body = `<?xml version="1.0"?><request opid="44" extsession="${Date.now()}" cur="EUR" desktopmode="true" lang="en_gb" screenres="1920,1080,1718,966" extjur="NA" />`;
const headers = {
  accept: '*/*',
  'content-type': 'text/xml; charset=utf-8',
  'X-CAPI-VERSION': '2.0',
  'X-CAPI-RID': `${Date.now()}0:1`,
  'X-CLIENT-VERSION': clientVersion,
  'X-ECF-VERSION': ecfVersion,
  origin: 'https://static-stage.contentmedia.eu',
  referer: 'https://static-stage.contentmedia.eu/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/158.0',
};
for (const key of omit) delete headers[key];
const res = await fetch(url, { method: 'POST', headers, body });
const text = await res.text();
const err = /<errorcode>(\d+)<\/errorcode>/.exec(text)?.[1];
const ses = /<id>([^<]+)<\/id>/.exec(text)?.[1];
console.log(`game=${gameId} client=${clientVersion} ecf=${ecfVersion} omit=${omit.join('+') || '-'} -> ${res.status} errorcode=${err} session=${ses ? ses.slice(0, 8) : '-'} ${text.slice(0, 90)}`);

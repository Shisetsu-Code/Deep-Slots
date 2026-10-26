const gameId = process.argv[2] ?? '10222';
const clientVersion = process.argv[3] ?? '263580';
const url = `https://gc5-stage.contentmedia.eu/capi/${gameId}/play/init?gl=true&standalone=false&iframe=true`;
const body = `<?xml version="1.0"?><request opid="44" extsession="${Date.now()}" cur="EUR" desktopmode="true" lang="en_gb" screenres="1920,1080,1718,966" extjur="NA" />`;
const res = await fetch(url, {
  method: 'POST',
  headers: {
    accept: '*/*',
    'accept-language': 'es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7',
    'content-type': 'text/xml; charset=utf-8',
    'X-CAPI-VERSION': '2.0',
    'X-CAPI-RID': `${Date.now()}${Math.floor(Math.random() * 100)}:1`,
    'X-CLIENT-VERSION': clientVersion,
    'X-ECF-VERSION': '369146',
    origin: 'https://static-stage.contentmedia.eu',
    referer: 'https://static-stage.contentmedia.eu/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:158.0) Gecko/20100101 Firefox/158.0',
  },
  body,
});
const text = await res.text();
console.log(res.status, res.statusText, text.slice(0, 1200));

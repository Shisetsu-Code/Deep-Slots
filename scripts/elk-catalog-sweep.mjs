// Cosecha del catalogo Elk: slug -> gameid (listado publico) -> init contra el capi.
// Con --spin ademas hace UN giro DEF de 0.20 por juego, lo cierra con checkwin y
// valida el saldo. No compra features ni toca el RNG: es el mismo flujo de un jugador.
//
//   node scripts/elk-catalog-sweep.mjs [catalogo.json] [--concurrency=4] [--limit=N] [--spin]
//
// Salida: .slots-artifacts/elk-sweep.json + resumen por consola.
import fs from 'node:fs';
import path from 'node:path';
import { ElkCapi } from '../dist/elk/client.js';
import { ElkGameSession } from '../dist/elk/session.js';
import { parseInit, elkFamilyKey, enabledFeatures, money } from '../dist/elk/types.js';

const args = process.argv.slice(2);
const catalogArg = args.find((a) => !a.startsWith('--'));
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};
const SPIN = args.includes('--spin');

const CATALOG =
  catalogArg ??
  'C:/Users/Shisetsu/AppData/Local/Temp/opencode/tester-spin/tester_spin/providers/catalogs/snapshots/elk.json';
const CONCURRENCY = flag('concurrency', 4);
const LIMIT = flag('limit', 0);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf8'));
const games = (catalog.games ?? []).slice(0, LIMIT > 0 ? LIMIT : undefined);
console.log(`catalogo: ${games.length} juegos (${path.basename(CATALOG)})`);

const norm = (value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * El listado publico de ELK trae, por cada tarjeta, el enlace a la ficha y el
 * `data-src` del launcher con el gameid. Un solo GET evita 158 peticiones y
 * los 429 del WordPress.
 */
async function loadGameIds() {
  const res = await fetch('https://www.elk-studios.com/games/', {
    headers: { 'user-agent': UA, accept: 'text/html' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`listado de juegos HTTP ${res.status}`);
  const html = await res.text();

  const slugs = [...html.matchAll(/href="https:\/\/www\.elk-studios\.com\/games\/([a-z0-9-]+)\/"/g)].map((m) => ({
    slug: m[1],
    at: m.index,
  }));
  const map = new Map();
  for (const m of html.matchAll(/gameid=(\d+)/g)) {
    const before = slugs.filter((s) => s.at < m.index).at(-1);
    const after = slugs.find((s) => s.at > m.index);
    const pick = before && m.index - before.at < 4000 ? before : after;
    if (pick && !map.has(pick.slug)) map.set(pick.slug, m[1]);
  }
  console.log(`listado: ${slugs.length} enlaces, ${map.size} gameids distintos`);
  return map;
}

const gameIds = await loadGameIds();

async function probe(game) {
  const row = {
    slug: game.slug,
    name: game.name,
    gameId: null,
    ok: false,
    error: null,
    errorcode: null,
    currency: null,
    balance: null,
    rtp: null,
    maxwin: null,
    hf: null,
    betlevels: 0,
    bmodes: [],
    betModes: [],
    variants: [],
    minspindelay: null,
    jurisdiction: null,
    defaultBetLevel: null,
    features: [],
    familyKey: null,
    spin: null,
  };

  try {
    const gameId = gameIds.get(game.slug) ?? gameIds.get(norm(game.slug));
    if (!gameId) {
      row.error = 'slug sin gameid en el listado';
      return row;
    }
    row.gameId = gameId;

    const options = {
      origin: 'https://gc5-stage.contentmedia.eu',
      gameId,
      operatorId: '44',
      currency: 'EUR',
      locale: 'en_gb',
      timeoutMs: 25000,
      retries: 1,
    };

    if (SPIN) {
      const session = new ElkGameSession(`sweep-${gameId}`, options);
      const info = await session.initialize();
      row.ok = true;
      row.currency = info.currency;
      row.balance = info.balance;
      row.rtp = info.rtp;
      row.maxwin = info.maxwin;
      row.hf = info.hf;
      row.betlevels = info.betlevels.length;
      row.bmodes = info.bmodes.map((b) => b.id);
      row.betModes = info.betModes;
      row.variants = info.variants.map((v) => v.id);
      row.minspindelay = info.minspindelay;
      row.jurisdiction = info.jurisdiction;
      row.defaultBetLevel = info.defaultBetLevel;
      row.features = enabledFeatures(info.features);
      row.familyKey = elkFamilyKey(
        {
          rtp: info.rtp,
          maxwin: info.maxwin,
          betlevels: info.betlevels.length,
          bmodes: info.betModes,
          features: info.features,
        },
        null,
      );

      const outcome = await session.spin({ betlevel: 1, bmode: 'DEF' });
      row.spin = {
        ok: outcome.ok,
        error: outcome.error,
        errorcode: outcome.errorcode,
        variant: outcome.round?.variant ?? session.variant,
        balance: session.balance,
        bet: outcome.round?.betamount ?? null,
        win: outcome.round?.winamount ?? null,
        validated: outcome.round?.validated ?? null,
        settled: outcome.round?.settled ?? null,
        seed: outcome.round?.pubdata?.seed ?? null,
        revision: outcome.round?.pubdata?.revision ?? null,
        results: outcome.round?.pubdata?.results.length ?? 0,
        actions: outcome.round?.pubdata?.actions ?? [],
        modes: outcome.round?.pubdata?.modes ?? [],
        durationMs: outcome.round?.durationMs ?? null,
      };
      return row;
    }

    const client = new ElkCapi(options);
    const result = await client.init();
    row.errorcode = result.errorcode;
    if (result.errorcode !== 0) {
      row.error = result.error ?? `errorcode ${result.errorcode}`;
      return row;
    }
    const info = parseInit(result.parsed);
    row.ok = true;
    row.currency = info.currency;
    row.balance = info.balance;
    row.rtp = info.rtp;
    row.maxwin = info.maxwin;
    row.hf = info.hf;
    row.betlevels = info.betlevels.length;
    row.bmodes = info.bmodes.map((b) => b.id);
    row.betModes = info.betModes;
    row.variants = info.variants.map((v) => v.id);
    row.minspindelay = info.minspindelay;
    row.jurisdiction = info.jurisdiction;
    row.defaultBetLevel = info.defaultBetLevel;
    row.features = enabledFeatures(info.features);
    row.familyKey = elkFamilyKey(
      {
        rtp: info.rtp,
        maxwin: info.maxwin,
        betlevels: info.betlevels.length,
        bmodes: info.betModes,
        features: info.features,
      },
      null,
    );
    return row;
  } catch (err) {
    row.error = err instanceof Error ? err.message : String(err);
    return row;
  }
}

const rows = [];
let cursor = 0;
let done = 0;

async function worker() {
  while (cursor < games.length) {
    const index = cursor++;
    const game = games[index];
    const row = await probe(game);
    rows[index] = row;
    done++;
    console.log(
      `[${String(done).padStart(3)}/${games.length}] ${(row.ok ? 'ok' : 'FALLO').padEnd(5)} ${game.slug.padEnd(30)} ` +
        (row.ok
          ? `game=${row.gameId} rtp=${row.rtp} maxwin=${row.maxwin} bets=${row.betlevels} bmodes=${row.betModes.join('+')}` +
            (row.variants.length ? ` variants=${row.variants.join('+')}` : '') +
            (row.spin
              ? ` | giro ${row.spin.ok ? 'OK' : 'FALLO'}${row.spin.ok ? ` win=${row.spin.win} val=${row.spin.validated}${row.spin.variant ? ` var=${row.spin.variant}` : ''}` : ` ${row.spin.error}`}`
              : '')
          : row.error),
    );
    await new Promise((r) => setTimeout(r, 120));
  }
}

const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const ok = rows.filter((r) => r.ok);
const noId = rows.filter((r) => !r.gameId);
const badInit = rows.filter((r) => r.gameId && !r.ok);
const spun = rows.filter((r) => r.spin);
const spinOk = spun.filter((r) => r.spin.ok && r.spin.validated === true);
const spinFail = spun.filter((r) => !r.spin.ok);
const spinMismatch = spun.filter((r) => r.spin.ok && r.spin.validated !== true);

const families = new Map();
for (const row of ok) {
  const key = row.familyKey ?? 'unknown';
  families.set(key, (families.get(key) ?? 0) + 1);
}

const outDir = path.resolve('.slots-artifacts');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'elk-sweep.json');
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      schema: 'deep-slots/elk-sweep/v1',
      generatedAt: new Date().toISOString(),
      catalog: CATALOG,
      durationMs: Date.now() - started,
      spins: SPIN,
      totals: {
        games: rows.length,
        ok: ok.length,
        noGameId: noId.length,
        initFailed: badInit.length,
        spinOk: spinOk.length,
        spinFailed: spinFail.length,
        spinMismatch: spinMismatch.length,
      },
      families: [...families.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
      games: rows,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('\n=== RESUMEN ===');
console.log(`init ok=${ok.length}  sin gameid=${noId.length}  init fallido=${badInit.length}  total=${rows.length}`);
if (SPIN) {
  console.log(`giros ok+validados=${spinOk.length}  fallidos=${spinFail.length}  descuadre=${spinMismatch.length}  de ${spun.length}`);
  const staked = spun.reduce((acc, r) => acc + (r.spin.bet ?? 0), 0);
  const won = spun.reduce((acc, r) => acc + (r.spin.win ?? 0), 0);
  console.log(`apostado=${money(staked)}  ganado=${money(won)}  rtp observado 1 giro/juego=${staked ? ((won / staked) * 100).toFixed(1) : '-'}%`);
  console.log(`hits=${spun.filter((r) => (r.spin.win ?? 0) > 0).length}  max win=${money(Math.max(0, ...spun.map((r) => r.spin.win ?? 0)))}`);
  if (spinFail.length) console.log(`\nGiro fallido: ${spinFail.map((r) => `${r.slug}#${r.gameId} (${r.spin.errorcode}) ${r.spin.error}`).join('\n  ')}`);
  if (spinMismatch.length) console.log(`\nDescuadre: ${spinMismatch.map((r) => `${r.slug}#${r.gameId} ${r.spin.error}`).join('\n  ')}`);
}
console.log(`rtp: ${[...new Set(ok.map((r) => r.rtp))].sort((a, b) => a - b).join(', ')}`);
console.log(`maxwin: ${[...new Set(ok.map((r) => r.maxwin))].sort((a, b) => a - b).join(', ')}`);
console.log(`betlevels: ${[...new Set(ok.map((r) => r.betlevels))].sort((a, b) => a - b).join(', ')}`);
const modeSets = new Map();
for (const row of ok) modeSets.set(row.betModes.join(',') || '(ninguno)', (modeSets.get(row.betModes.join(',') || '(ninguno)') ?? 0) + 1);
console.log('juegos por bmodes:');
for (const [set, count] of [...modeSets.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(3)}  ${set}`);
console.log(
  `minspindelay != 1200: ${
    ok
      .filter((r) => r.minspindelay !== 1200)
      .map((r) => `${r.slug}:${r.minspindelay}`)
      .join(' ') || 'ninguno'
  }`,
);
console.log(`jurisdicciones: ${[...new Set(ok.map((r) => r.jurisdiction))].join(', ')}`);
console.log(`familias (clave completa): ${families.size}`);
console.log('\nFamilias:');
for (const [key, count] of [...families.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(3)}  ${key}`);
}
if (noId.length) console.log(`\nSin gameid: ${noId.map((r) => `${r.slug} (${r.error})`).join(', ')}`);
if (badInit.length) console.log(`\nInit fallido: ${badInit.map((r) => `${r.slug}#${r.gameId}:${r.error}`).join(', ')}`);
console.log(`\nJSON: ${outFile}`);
console.log(`saldo demo agregado (sin gastar): ${money(ok.reduce((acc, r) => acc + (r.balance ?? 0), 0))}`);

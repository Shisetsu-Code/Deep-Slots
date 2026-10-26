import { loadHar } from '../dist/har/loader.js';
import { buildElkCard } from '../dist/har/elk-card.js';
import { summarizeHar } from '../dist/har/summary.js';

const files = process.argv.slice(2);
const hars = files.map((f) => loadHar(f));
console.log('files:', hars.map((h) => `${h.entries.length} entries`).join(', '));

const s = summarizeHar(hars[0], { top: 10 });
console.log('hosts:', s.hosts.slice(0, 5).map((h) => `${h.value}=${h.count}`).join(' '));
console.log('builds:', s.builds.map((b) => `${b.bundle}@${b.build}`).join(' '));
console.log('games:', JSON.stringify(s.games));
console.log('api:', s.api.length);

const card = buildElkCard(hars, { redact: false, maxChars: 300 });
console.log('\nCARD games:', card.games.length, 'builds:', card.builds.length, 'notes:', card.notes);
for (const g of card.games) {
  console.log('\n=== game', g.gameId, g.names, g.slugs, '===');
  console.log('ops', g.ops);
  console.log('variant', g.variants, 'revision', g.revisions, 'builds', g.builds);
  console.log('declared', JSON.stringify(g.declared && {
    rtp: g.declared.rtp,
    maxwin: g.declared.maxwin,
    hf: g.declared.hf,
    minspindelay: g.declared.minspindelay,
    betlevels: g.declared.betlevels,
    bmodes: g.declared.bmodes,
    features: Object.keys(g.declared.features),
  }));
  console.log('bets', JSON.stringify(g.bets));
  console.log('observed', g.observed);
  console.log('audit', g.balanceAudit);
  console.log('rounds', g.rounds.map((r) => `${r.roundid} bet=${r.betamount} win=${r.winamount} ${r.bmode} bal=${r.balanceAfterPurchase}->${r.balanceAfterCheckwin} ok=${r.balanced} res=${r.results} acts=${r.actions.length}`));
  console.log('supported', g.executionSupported, 'notes', g.notes);
  console.log('sample keys', Object.keys(g.samples));
}

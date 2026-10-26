import { ElkGameSession } from '../dist/elk/session.js';

const gameId = process.argv[2] ?? '10222';
const doSpin = process.argv[3] === 'spin';

const session = new ElkGameSession('live', {
  origin: 'https://gc5-stage.contentmedia.eu',
  gameId,
  operatorId: '44',
  currency: 'EUR',
  locale: 'en_gb',
  timeoutMs: 25000,
  retries: 1,
});

try {
  const info = await session.initialize();
  console.log('INIT OK', {
    gameId,
    currency: info.currency,
    balance: info.balance,
    rtp: info.rtp,
    maxwin: info.maxwin,
    hf: info.hf,
    betlevels: info.betlevels.length,
    bmodes: info.bmodes.map((b) => `${b.id}:${b.display}`).join(' '),
    minspindelay: info.minspindelay,
    jurisdiction: info.jurisdiction,
    defaultBetLevel: info.defaultBetLevel,
    gameprops: info.gameprops,
  });

  if (doSpin) {
    const outcome = await session.spin({ betlevel: 1, bmode: 'DEF' });
    console.log('SPIN', {
      ok: outcome.ok,
      error: outcome.error,
      balance: outcome.balance,
      round: outcome.round && {
        roundid: outcome.round.roundid,
        bet: outcome.round.betamount,
        win: outcome.round.winamount,
        bmode: outcome.round.bmode,
        balanceAfterPurchase: outcome.round.balanceAfterPurchase,
        balanceAfterSettle: outcome.round.balanceAfterSettle,
        validated: outcome.round.validated,
        pubdata: outcome.round.pubdata && {
          seed: outcome.round.pubdata.seed,
          revision: outcome.round.pubdata.revision,
          results: outcome.round.pubdata.results.length,
          modes: outcome.round.pubdata.modes,
          actions: outcome.round.pubdata.actions.slice(0, 12),
        },
      },
    });
  }
  console.log('CARD', JSON.stringify(session.card(), null, 2).slice(0, 2500));
} catch (err) {
  console.error('LIVE ERROR:', err.message);
  if (err.response) console.error('BODY:', String(err.response).slice(0, 800));
  process.exitCode = 1;
}

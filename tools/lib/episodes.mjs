// v469 — ONE MOVE IS ONE OBSERVATION.
//
// The engine republishes a setup on every scan while its conditions still
// hold, and the watcher banks each publication as its own row. A trending
// instrument therefore produces a long run of near-identical rows that all
// resolve together — 28 ETH BUY rows inside a nine-dollar entry band on the
// 19th, every one of them a full winner.
//
// Treating those as independent samples inflates every statistic computed
// from them. Measured on this book: 247 resolved rows collapse to 35 real
// episodes, a factor of 7. Uncorrected it moved the average from -0.221R to
// -0.005R and promoted three slices to "positive edge, interval clears zero"
// that a correct count does not support.
//
// Shared by the brain and the self-evaluator so the two can never disagree
// about what counts as a sample.
export function toEpisodes(rows) {
  const sorted = rows.slice().sort((a, b) => String(a.firedAt).localeCompare(String(b.firedAt)));
  const eps = [];
  for (const x of sorted) {
    const t = Date.parse(x.firedAt);
    if (!Number.isFinite(t)) continue;
    let placed = false;
    for (const e of eps) {
      if (e.pair !== x.pair || e.direction !== x.direction) continue;
      // A new row belongs to the running episode if it fired while the
      // earlier trade was still live.
      const lifeH = Math.max(e.bars || 12, 6);
      if ((t - e.lastAt) / 3600000 <= lifeH) {
        e.members.push(x);
        e.lastAt = t;
        e.bars = Math.max(e.bars || 0, x.barsWatched || 12);
        placed = true;
        break;
      }
    }
    if (!placed) eps.push({
      pair: x.pair, direction: x.direction, firedAt: x.firedAt,
      lastAt: t, bars: x.barsWatched || 12, members: [x],
    });
  }
  return eps.map(e => {
    const rs = e.members.map(m => m.resultR).filter(v => typeof v === 'number');
    const rep = { ...e.members[0] };
    if (rs.length) rep.resultR = rs.reduce((a, b) => a + b, 0) / rs.length;
    const maes = e.members.map(m => m.maeR).filter(v => typeof v === 'number');
    const mfes = e.members.map(m => m.mfeR).filter(v => typeof v === 'number');
    if (maes.length) rep.maeR = maes.reduce((a, b) => a + b, 0) / maes.length;
    if (mfes.length) rep.mfeR = mfes.reduce((a, b) => a + b, 0) / mfes.length;
    rep._episodeSize = e.members.length;
    return rep;
  });
}

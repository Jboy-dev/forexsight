// v465 — DOES THE ENGINE ACTUALLY SEE THE CHART CORRECTLY?
//
// Every signal is a claim about candles. If a bar is stale, duplicated, out of
// order, or violates its own high/low, the analysis on top of it is wrong no
// matter how good the strategy is — and it fails silently, because a number is
// still produced. v452 was exactly this: a fallback that lacked history turned
// winners into recorded losses for a full day before anyone noticed.
//
// This checks the bars themselves against things that must be true, and
// publishes the result so a data fault shows up as a fault instead of as a bad
// trade. It does not judge whether a signal is good — only whether the input it
// was computed from is sound.
import { readFileSync, writeFileSync, readdirSync } from 'fs';

const DIR = 'data/ohlc';
const MAX_AGE_H = 6;      // beyond this the read is not "live"
const report = { ts: Date.now(), isoTime: new Date().toISOString(), instruments: [], problems: [] };

const num = v => typeof v === 'number' && Number.isFinite(v);

for (const f of readdirSync(DIR).filter(x => x.endsWith('.json'))) {
  const pair = f.replace('.json', '').replace('-', '/');
  let bars;
  try {
    const raw = JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
    bars = Array.isArray(raw) ? raw : (raw.bars || raw.ohlc || []);
  } catch (e) {
    report.problems.push(`${pair}: file unreadable (${e.message})`);
    continue;
  }

  const issues = [];
  let marketClosedNote = null;
  if (!bars.length) { report.problems.push(`${pair}: no bars`); continue; }

  // Ordering, duplicates, gaps.
  let outOfOrder = 0, dupes = 0;
  const spacings = [];
  for (let i = 1; i < bars.length; i++) {
    const dt = bars[i].t - bars[i - 1].t;
    if (dt < 0) outOfOrder++;
    else if (dt === 0) dupes++;
    else spacings.push(dt);
  }
  spacings.sort((a, b) => a - b);
  const median = spacings[Math.floor(spacings.length / 2)] || 0;
  // A gap is a spacing well beyond the normal cadence. Weekends are expected
  // on FX, so only flag gaps that are not weekend-shaped.
  let gaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const dt = bars[i].t - bars[i - 1].t;
    if (median > 0 && dt > median * 3) {
      const d = new Date(bars[i - 1].t).getUTCDay();
      const weekendish = (d === 5 || d === 6 || d === 0) && dt <= median * 60;
      if (!weekendish) gaps++;
    }
  }

  // Each candle must be internally consistent.
  let badOHLC = 0, nonFinite = 0, nonPositive = 0;
  for (const b of bars) {
    if (!num(b.o) || !num(b.h) || !num(b.l) || !num(b.c) || !num(b.t)) { nonFinite++; continue; }
    if (b.o <= 0 || b.h <= 0 || b.l <= 0 || b.c <= 0) { nonPositive++; continue; }
    if (b.h < b.l || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) badOHLC++;
  }

  // Data discontinuity, NOT volatility.
  //
  // The first version of this flagged any bar with a large true range, and it
  // duly flagged five USD/JPY bars from the genuine 163->155 selloff at the end
  // of July. Those bars were real: each opened within a fraction of the prior
  // close and trended through. A detector that reports real market moves as
  // faults teaches you to ignore it, so it now tests the thing that actually
  // indicates bad data — a bar whose OPEN is disconnected from the previous
  // CLOSE. Continuous markets do not gap mid-session; a feed splicing two
  // different series does.
  const gapsFromClose = [];
  for (let i = 1; i < bars.length; i++) {
    const p = bars[i - 1], c = bars[i];
    if (!num(c.o) || !num(p.c) || p.c === 0) continue;
    const dt = c.t - p.t;
    // Skip session/weekend boundaries, where a real gap is expected.
    if (median > 0 && dt > median * 2) continue;
    gapsFromClose.push(Math.abs(c.o - p.c) / p.c);
  }
  const sortedGap = gapsFromClose.slice().sort((a, b) => a - b);
  const medGap = sortedGap[Math.floor(sortedGap.length / 2)] || 0;
  // 0.4% mid-session open-to-prior-close discontinuity is not a market move.
  const spikes = gapsFromClose.filter(g => g > Math.max(0.004, medGap * 50)).length;

  const last = bars[bars.length - 1];
  const ageH = (Date.now() - (last.t || 0)) / 3600000;

  if (outOfOrder)  issues.push(`${outOfOrder} bar(s) out of chronological order`);
  if (dupes)       issues.push(`${dupes} duplicate timestamp(s)`);
  if (gaps)        issues.push(`${gaps} unexplained gap(s) in the series`);
  if (badOHLC)     issues.push(`${badOHLC} candle(s) violate high/low bounds`);
  if (nonFinite)   issues.push(`${nonFinite} bar(s) with missing or non-numeric fields`);
  if (nonPositive) issues.push(`${nonPositive} bar(s) with a non-positive price`);
  if (spikes)      issues.push(`${spikes} bar(s) open disconnected from the previous close — possible feed splice`);
  // v480 — A CLOSED MARKET IS NOT A STALE FEED.
  //
  // This flagged any instrument whose last bar was over six hours old. On a
  // Sunday that is every FX pair and gold, because the market shut at 22:00
  // Friday — so the report read 2/10 clean and pointed at nothing wrong.
  // A checker that alarms every weekend teaches you to ignore it, which is
  // worse than not having one, and it is the second time this file has made
  // that mistake (the first flagged the real USD/JPY selloff as corrupt).
  //
  // FX and metals trade roughly 22:00 Sunday to 22:00 Friday UTC. Crypto never
  // closes, so it is held to the live standard at all times.
  const isCrypto = ['BTC/USD', 'ETH/USD', 'SOL/USD'].includes(pair);
  const nowD = new Date();
  const dow = nowD.getUTCDay();            // 0=Sun .. 6=Sat
  const hourUTC = nowD.getUTCHours();
  const marketClosed = !isCrypto && (
    dow === 6 ||                            // all Saturday
    (dow === 0 && hourUTC < 22) ||          // Sunday before the open
    (dow === 5 && hourUTC >= 22)            // Friday after the close
  );
  if (ageH > MAX_AGE_H && !marketClosed) {
    issues.push(`last bar is ${ageH.toFixed(1)}h old — not a live read`);
  } else if (marketClosed && ageH > MAX_AGE_H) {
    // Recorded, not raised: the data is as fresh as the market allows.
    marketClosedNote = `market closed — last bar ${ageH.toFixed(1)}h old, which is the Friday close`;
  }
  if (bars.length < 200) issues.push(`only ${bars.length} bars — some strategies need 200`);

  report.instruments.push({
    pair, bars: bars.length,
    marketClosed: !!marketClosedNote,
    marketNote: marketClosedNote,
    lastBarAgeHours: +ageH.toFixed(2),
    medianSpacingMinutes: Math.round(median / 60000),
    clean: issues.length === 0,
    issues,
  });
  for (const i of issues) report.problems.push(`${pair}: ${i}`);
}

report.instrumentsChecked = report.instruments.length;
report.instrumentsClean = report.instruments.filter(i => i.clean).length;
report.healthy = report.problems.length === 0;
report.verdict = report.healthy
  ? `All ${report.instrumentsChecked} instruments passed every integrity check.`
  : `${report.problems.length} issue(s) across ${report.instrumentsChecked - report.instrumentsClean} instrument(s).`;

writeFileSync('data/data-quality.json', JSON.stringify(report, null, 2));

console.log(`chart integrity: ${report.instrumentsClean}/${report.instrumentsChecked} instruments clean`);
for (const i of report.instruments) {
  const age = i.lastBarAgeHours.toFixed(1).padStart(5);
  console.log(`  ${i.clean ? '✓' : '✗'} ${i.pair.padEnd(9)} ${String(i.bars).padStart(4)} bars  last ${age}h ago  ${i.issues.join('; ')}`);
}
if (!report.healthy) console.log(`\n${report.verdict}`);

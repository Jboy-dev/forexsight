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
  // Classified by PATTERN rather than an explicit list, because a list goes out
  // of date the moment the universe grows — which is exactly how XRP ended up
  // judged against the FX threshold.
  const isIndex = /^(US30|NAS100|SPX500|UK100|GER40|JP225)$/.test(pair);

  // ── WHAT SEPARATES A CLOSURE FROM A HOLE ──────────────────────────────
  //
  // Seven false alarms have now come from this one question, each patched with
  // another special case: weekends, then long weekends, then index overnights,
  // then Thursday holidays, then 15m weekends. Every patch was a guess about
  // WHICH markets close WHEN, and the next instrument broke it again.
  //
  // The distinguishing property is not the day, the duration, or the asset
  // class. It is that A CLOSURE RECURS AT THE SAME CLOCK TIME and a fault does
  // not. Gold halts at 21:00 UTC every day; an index closes at 20:00 every day;
  // FX stops Friday evening every week. A missing hour in the middle of a
  // session happens once.
  //
  // So the series tells us its own schedule: gaps are grouped by the hour they
  // begin at, and any hour that accounts for a repeated, regular pattern is
  // this instrument's closing time. Nothing is hard-coded per market.
  const gapStarts = [];
  for (let i = 1; i < bars.length; i++) {
    const dt = bars[i].t - bars[i - 1].t;
    if (median > 0 && dt > median * 3) {
      gapStarts.push({ i, dt, hour: new Date(bars[i - 1].t).getUTCHours(),
                       day: new Date(bars[i - 1].t).getUTCDay() });
    }
  }
  const hourCounts = new Map();
  for (const g of gapStarts) hourCounts.set(g.hour, (hourCounts.get(g.hour) || 0) + 1);
  // An hour is a scheduled close if it accounts for several gaps. One-offs are
  // never scheduled; a daily halt shows up dozens of times.
  const scheduledHours = new Set([...hourCounts.entries()].filter(([, n]) => n >= 5).map(([h]) => h));

  // Per-bar integrity: impossible candles, missing fields, non-positive prices.
  let badOHLC = 0, nonFinite = 0, nonPositive = 0;
  for (const b of bars) {
    if (!num(b.o) || !num(b.h) || !num(b.l) || !num(b.c) || !num(b.t)) { nonFinite++; continue; }
    if (b.o <= 0 || b.h <= 0 || b.l <= 0 || b.c <= 0) { nonPositive++; continue; }
    if (b.h < b.l || b.h < Math.max(b.o, b.c) || b.l > Math.min(b.o, b.c)) badOHLC++;
  }

  let gaps = 0;
  for (const g of gapStarts) {
    const gapHours = g.dt / 36e5;
    // Begins at an hour this instrument regularly stops trading -> a closure.
    if (scheduledHours.has(g.hour)) continue;
    // Or it is a weekend, which every market takes.
    if ((g.day === 5 || g.day === 6 || g.day === 0) && gapHours <= 96) continue;
    gaps++;
  }

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
  // v481 — the discontinuity threshold has to know what it is looking at.
  //
  // A flat 0.4% flagged ETH for a 0.53% hourly open gap on 29 July, which was
  // a real crypto move. That is the third false alarm this file has produced:
  // it once reported the genuine USD/JPY selloff as corrupt, and it called
  // every weekend a dead feed. Each time the data was right and the check was
  // wrong, and a check that cries wolf gets ignored, which defeats the purpose
  // of having it.
  //
  // Crypto routinely gaps a percent between hourly opens; FX majors almost
  // never move that far mid-session, so the same number cannot serve both.
  // Classified by PATTERN, not by an explicit list. The list version went out of
  // date the moment instruments were added: XRP/USD was missing from it, so it
  // was judged against the FX threshold of 0.4% when crypto routinely gaps more
  // than that between hourly opens — 27 perfectly good bars were reported as a
  // feed splice. A rule that has to be edited every time the universe grows
  // will be wrong again, so this derives from the symbol itself.
  const cryptoPair = /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB)\//.test(pair);
  const goldPair = /^(XAU|XAG|XPT|XPD)\//.test(pair);
  const indexPair = isIndex;
  const jumpFloor = cryptoPair ? 0.025 : goldPair ? 0.010 : indexPair ? 0.012 : 0.004;
  const spikes = gapsFromClose.filter(g => g > Math.max(jumpFloor, medGap * 50)).length;

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
  // Same pattern test as above — a second hard-coded list here is how XRP
  // slipped through the first fix.
  const isCrypto = /^(BTC|ETH|SOL|XRP|ADA|DOGE|LTC|BNB)\//.test(pair);
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

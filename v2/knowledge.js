/* ============================================================================
   v2/knowledge.js — Research. Ask it anything about this site or about trading.

   TWO KINDS OF ANSWER, AND THEY ARE NEVER MIXED:

   · MEASURED — computed live from the files this page already loaded. Every
     such answer carries the number AND where it came from, so it can be
     checked. If the file is missing, the answer says so rather than guessing.

   · MECHANICAL — definitions and arithmetic that are true by construction:
     what an R-multiple is, how expectancy is computed, why a 70% win rate can
     still lose money. These do not depend on any forecast.

   WHAT IT WILL NOT DO: predict a price, name "the best pair to trade now", or
   tell you a setup will win. Those answers would have to be invented, and an
   invented answer in a trading tool costs money. It refuses them explicitly and
   says what it can offer instead.
   ========================================================================== */
'use strict';

const KB_ESC = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const kbNum = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const kbSign = (n) => (n == null ? '' : n > 0 ? '+' : '');

/* ── helpers that read the live state ──────────────────────────────────── */
function kbBrain(S) { return S && S.learningBrain; }
function kbMissing(what, file) {
  return { body: `<p>I cannot answer that right now: <code>${KB_ESC(file)}</code> has not loaded, so I have no ${KB_ESC(what)} to report. I would rather say that than show you a number I made up.</p>`, source: 'nothing — the file is missing' };
}

const TOPICS = [
  /* ═══ ABOUT THIS SITE — all MEASURED ═══════════════════════════════════ */
  {
    id: 'record', kind: 'measured',
    q: 'How has this site actually performed?',
    keys: ['record', 'performance', 'profitable', 'win rate', 'winrate', 'how good', 'results', 'track record', 'making money', 'does it work', 'actually work', 'any good', 'trustworthy'],
    answer(S) {
      const b = kbBrain(S); if (!b) return kbMissing('record', 'learning-brain.json');
      const m = b.measures || {}, ev = m.everySignal || b.headline || {}, ep = m.episodeAverage;
      const raw = kbNum(b.rawPublications), col = kbNum(b.totalSamples);
      const disagree = ep && kbNum(ep.avgR) != null && kbNum(ev.avgR) != null && (ep.avgR > 0) !== (ev.avgR > 0);
      return { body: `
        <p>Three measures of the same book, because they disagree and picking one would be choosing a story:</p>
        <table class="kb-t"><tr><th>measure</th><th>avg R</th><th>samples</th><th>interval</th></tr>
        <tr><td>every published signal</td><td>${kbSign(ev.avgR)}${KB_ESC(ev.avgR)}R</td><td>${KB_ESC(ev.samples)}</td><td>[${KB_ESC(ev.ci?.join(', '))}]</td></tr>
        ${ep ? `<tr><td>collapsed to episodes</td><td>${kbSign(ep.avgR)}${KB_ESC(ep.avgR)}R</td><td>${KB_ESC(ep.samples)}</td><td>[${KB_ESC(ep.ci?.join(', '))}]</td></tr>` : ''}
        ${m.firstOfEpisode ? `<tr><td>first of each episode</td><td>${kbSign(m.firstOfEpisode.avgR)}${KB_ESC(m.firstOfEpisode.avgR)}R</td><td>${KB_ESC(m.firstOfEpisode.samples)}</td><td>[${KB_ESC(m.firstOfEpisode.ci?.join(', '))}]</td></tr>` : ''}
        </table>
        ${raw && col ? `<p>${raw} publications collapse to ${col} independent moves — republications of one move are not separate evidence. Counting the raw number would overstate the sample by ${(raw / col).toFixed(2)}x.</p>` : ''}
        ${disagree ? `<p><strong>The first two disagree in sign.</strong> Per signal it reads positive; collapsed to independent moves it reads negative. The second respects independence, so <strong>this book is not established as profitable.</strong></p>` : ''}
        <p>Every interval above includes zero. That means the result is not distinguishable from chance in either direction — not that it is good, and not that it is bad.</p>`,
        source: 'data/learning-brain.json, rebuilt every cycle from resolved signals' };
    },
  },
  {
    id: 'strategies', kind: 'measured',
    q: 'What strategies have been tested, and did any work?',
    keys: ['strateg', 'backtest', 'tested', 'what works', 'best strategy', 'proven', 'edge', 'trials', 'search'],
    answer(S) {
      const t = S && S.strategyTrials, a = S && S.activeStrategy;
      if (!t) return kbMissing('strategy results', 'strategy-trials.json');
      const sealed = t.sealed || [], passed = t.passed || [];
      const worst = sealed[0];
      return { body: `
        <p><strong>${KB_ESC(t.hypotheses)} combinations</strong> tested over ${KB_ESC((t.totalDailyBars || 0).toLocaleString())} bars across ${KB_ESC(t.instruments)} markets. <strong>${passed.length} passed.</strong></p>
        <p>The method is built to stop me fooling myself: a three-way split where the newest 25% is opened <em>once</em>; non-overlapping trades so no two observations share an outcome; costs charged; the stop checked before targets within a bar; and the significance bar Bonferroni-corrected to <code>|t| &gt; ${KB_ESC(t.bonferroniBarT)}</code> because testing ${KB_ESC(t.hypotheses)} and keeping the best is not the same as testing one.</p>
        ${worst && worst.train ? `<p>The decay is the same in every survivor. The best one:</p>
        <table class="kb-t"><tr><th>stage</th><th>avg R</th><th>t</th></tr>
        <tr><td>train</td><td>${kbSign(worst.train.avgR)}${KB_ESC(worst.train.avgR)}R</td><td>${KB_ESC(worst.train.t)}</td></tr>
        ${worst.validate ? `<tr><td>validate</td><td>${kbSign(worst.validate.avgR)}${KB_ESC(worst.validate.avgR)}R</td><td>${KB_ESC(worst.validate.t)}</td></tr>` : ''}
        ${worst.sealed && !worst.sealed.tooFew ? `<tr><td>sealed</td><td>${kbSign(worst.sealed.avgR)}${KB_ESC(worst.sealed.avgR)}R</td><td>${KB_ESC(worst.sealed.t)}</td></tr>` : ''}
        </table>
        <p>Strong where it was chosen, gone where it was not. That is what overfitting looks like.</p>` : ''}
        ${worst && worst.sealed && worst.sealed.nullP95 != null ? `<p>And entering <em>at random</em> with the same ladder scored +${KB_ESC(worst.sealed.nullP95)}R at its 95th percentile — above the best strategy's sealed result. Chance beat them.</p>` : ''}
        <p>${KB_ESC((a && a.verdict) || t.verdict)}</p>`,
        source: 'data/strategy-trials.json and data/active-strategy.json, re-run continuously' };
    },
  },
  {
    id: 'ladder', kind: 'mechanical',
    q: 'How does the TP1/TP2/TP3 ladder work?',
    keys: ['ladder', 'tp1', 'tp2', 'tp3', 'take profit', 'target', 'how do i manage', 'manage the trade', 'partial'],
    answer() {
      return { body: `
        <p>Risk is <strong>1R</strong> — the distance from entry to stop. Every target is a multiple of it, so the numbers mean the same thing on gold as on a yen pair.</p>
        <table class="kb-t"><tr><th>level</th><th>distance</th><th>action</th></tr>
        <tr><td>TP1</td><td>1.2R</td><td>bank a third</td></tr>
        <tr><td>TP2</td><td>2.0R</td><td>bank a third, move the stop to entry</td></tr>
        <tr><td>TP3</td><td>3.5R</td><td>close the rest, stop having moved to TP1</td></tr></table>
        <p>A full run pays <strong>(1.2 + 2.0 + 3.5) ÷ 3 = +2.233R</strong> against −1.000R if it stops out immediately. The site refuses to publish any setup where that arithmetic does not favour the run, and TP1 must always exceed the stop distance.</p>
        <p>What that is <em>not</em>: evidence the setup wins. It is the shape of the payoff if it does. Geometry and probability are separate questions, and only the first is settled here.</p>`,
        source: 'the invariants enforced in functions/api/check-signals.js' };
    },
  },
  {
    id: 'data', kind: 'measured',
    q: 'What data does this run on, and is it trustworthy?',
    keys: ['data', 'bars', 'history', 'how much data', 'source', 'where does', 'trustworthy', 'reliable data', 'tradingview', 'chart'],
    answer(S) {
      const v = S && S.marketVoice;
      return { body: `
        <p>Daily history: <strong>${KB_ESC((v?.totalDailyBars || 0).toLocaleString())} bars</strong> across ${KB_ESC(v?.instruments || '?')} markets, the deepest each instrument offers — back to 1996 for USD/JPY. Intraday: <strong>~224,000 bars</strong>, H1 reaching 1,020 days.</p>
        <p>It is verified rather than assumed. Five checks run before anything learns from it: structure, gaps, agreement between the H1 and daily feeds for the same instrument, implausible prints, and a triangular-arithmetic control.</p>
        <p><strong>One real finding you should know.</strong> The FX feed is bid-only, and bid-only data manufactures a fake edge at the daily rollover. The triangular control (EURUSD×USDJPY against GBPUSD×USDCHF) found systematic structure at 02:00, 19:00, 21:00 and 22:00 UTC, worst t=5.55. So no session or time-of-day rule is used anywhere, because on this feed such a result would be an artefact of the data rather than an effect in the market.</p>
        <p>Charts are read from price bars directly, not scraped from TradingView — same OHLC a chart draws, read as numbers.</p>`,
        source: 'data/intraday-verification.json and data/market-voice.json' };
    },
  },
  {
    id: 'weak', kind: 'measured',
    q: 'Why is a signal marked weak, or its win chance not shown?',
    keys: ['weak', 'why is this', 'confidence', 'conf ', 'win chance', 'not scored', 'episode', 'brainnote', 'what does best mean', 'tier'],
    answer(S) {
      const b = kbBrain(S);
      const need = b?.minSamplesForUse ?? 20;
      return { body: `
        <p><strong>Weak</strong> means the setup passed the hard gates — the ladder arithmetic, the stop placement, the news window — but scored low on structure, agreement between methods, or regime fit. It is published rather than hidden so you can see what the engine rejected on quality rather than on rules.</p>
        <p><strong>"Win chance not scored"</strong> means exactly that: fewer than ${KB_ESC(need)} independent resolved episodes exist for that combination, so any percentage would be noise wearing a number. A win rate from 4 trades tells you nothing, and printing one would be worse than printing nothing.</p>
        <p><strong>Confidence</strong> is the engine's internal structure score, not a probability. A confidence of 97 does not mean 97% — nothing on this page claims a probability it has not measured.</p>`,
        source: 'data/learning-brain.json, minSamplesForUse' };
    },
  },
  {
    id: 'market', kind: 'measured',
    q: 'What is the market doing right now?',
    keys: ['market doing', 'right now', 'what is the market', 'dollar', 'risk', 'breadth', 'volatility', 'conditions', 'today'],
    answer(S) {
      const v = S && S.marketVoice;
      if (!v) return kbMissing('market read', 'market-voice.json');
      const r = v.reads || {};
      return { body: `
        <p><strong>${KB_ESC(v.headline)}</strong></p>
        <table class="kb-t"><tr><th>read</th><th>value</th><th>meaning</th></tr>
        <tr><td>dollar</td><td>${KB_ESC(kbSign(r.dollar?.value) + r.dollar?.value)}%</td><td>${KB_ESC(r.dollar?.state)}</td></tr>
        <tr><td>risk appetite</td><td>${KB_ESC(kbSign(r.risk?.value) + r.risk?.value)}%</td><td>${KB_ESC(r.risk?.state)}</td></tr>
        <tr><td>breadth</td><td>${KB_ESC(r.breadth?.value)}%</td><td>${KB_ESC(r.breadth?.state)}</td></tr></table>
        <p>${KB_ESC(v.honesty)}</p>
        <p>These describe. They were each regressed against the next five days' returns with the t-stat corrected for window overlap, and none clears the bar — so they are context for your own judgement, not an input to any signal.</p>`,
        source: 'data/market-voice.json, rebuilt each cycle' };
    },
  },
  {
    id: 'orders', kind: 'mechanical',
    q: 'What can I tell the site to do?',
    keys: ['command', 'order', 'tell it', 'what can i type', 'filter', 'how do i use', 'help me use', 'controls'],
    answer() {
      const list = (window.FS && window.FS.COMMANDS) ? window.FS.COMMANDS.map(c => c.help) : [];
      return { body: `
        <p>Type into the bar at the top. Orders stack, persist across reloads, and each one in force shows as a chip you can click off.</p>
        <ul class="kb-l">${list.map(h => `<li><code>${KB_ESC(h.split('·')[0].trim())}</code> — ${KB_ESC(h)}</li>`).join('')}</ul>
        <p>Phrasing is forgiving: "show me the gold setups please", "only gold" and "gold" all do the same thing. Anything it does not understand is refused out loud rather than quietly filtering your page to empty.</p>`,
        source: 'v2/commands.js — the live registry, so this list cannot drift' };
    },
  },

  /* ═══ TRADING — MECHANICAL, true by construction ════════════════════════ */
  {
    id: 'r-multiple', kind: 'mechanical',
    q: 'What is an R-multiple and why use it?',
    keys: ['r multiple', 'what is r', 'rr', 'risk reward', '1r', 'what does r mean'],
    answer() {
      return { body: `
        <p><strong>1R is what you lose if the stop is hit.</strong> Every other number is expressed as a multiple of it.</p>
        <p>It is the only unit that lets you compare a gold trade risking 300 points with a yen trade risking 20 pips. In R, both risk 1 and you can add them up honestly.</p>
        <p>It also removes position size from the question. A +2R result is +2R whether you risked £10 or £1,000 — the decision quality and the stake are separated, which is the whole point.</p>`,
        source: 'definitional' };
    },
  },
  {
    id: 'expectancy', kind: 'mechanical',
    q: 'Why can a 70% win rate still lose money?',
    keys: ['expectancy', 'win rate', '70%', 'lose money', 'high win rate', 'profitable', 'maths', 'math', 'average'],
    answer() {
      return { body: `
        <p>Because win rate says nothing about size. Expectancy is what matters:</p>
        <p class="kb-eq">E = (win% × average win) − (loss% × average loss)</p>
        <p>Winning 70% of the time at +0.5R and losing 30% at −2R:</p>
        <p class="kb-eq">(0.70 × 0.5) − (0.30 × 2.0) = 0.35 − 0.60 = <strong>−0.25R per trade</strong></p>
        <p>A losing system with a win rate most people would envy. The reverse holds too: 40% at +3R against 60% at −1R is (0.4×3) − (0.6×1) = <strong>+0.6R</strong>.</p>
        <p>This is why this site reports <strong>average R</strong> first and win rate second. A tool that advertises win rate is selling you the flattering number.</p>`,
        source: 'arithmetic' };
    },
  },
  {
    id: 'sizing', kind: 'mechanical',
    q: 'How do I size a position?',
    keys: ['position siz', 'lot size', 'how much should i risk', 'how many lots', 'stake', 'risk per trade', 'money management'],
    answer() {
      return { body: `
        <p>Size is derived from the stop, never chosen first:</p>
        <p class="kb-eq">size = (account × risk%) ÷ (stop distance × value per point)</p>
        <p>£10,000 account, 1% risk, a 20-pip stop on EUR/USD at £1/pip per mini-lot: £100 ÷ 20 = <strong>£5 per pip</strong>, so 5 mini-lots.</p>
        <p>Two consequences worth internalising. A wider stop means a <em>smaller</em> position, not more risk — the risk is fixed and the size absorbs the difference. And the stop belongs where the chart invalidates the idea; moving it closer to afford a bigger position is backwards, and is how a 1% risk quietly becomes a 5% one.</p>
        <p class="kb-warn">This is the arithmetic, not advice on what your risk percentage should be. That depends on your circumstances, and I am not the right thing to ask.</p>`,
        source: 'arithmetic' };
    },
  },
  {
    id: 'atr', kind: 'mechanical',
    q: 'What are ATR and ADX, and what do they actually tell you?',
    keys: ['atr', 'adx', 'indicator', 'average true range', 'what does adx', 'volatility measure', 'rsi', 'moving average'],
    answer() {
      return { body: `
        <p><strong>ATR</strong> — average true range — is typical movement per bar, including gaps. It is a <em>size</em> measure with no direction in it. Its honest use is placing stops: a stop inside one ATR is inside the market's ordinary noise and will be hit by nothing in particular.</p>
        <p><strong>ADX</strong> measures trend <em>strength</em>, also without direction. Conventionally below 20 is rangebound and above 25–30 is trending. It says how hard price is pushing, never which way.</p>
        <p><strong>RSI</strong> is the ratio of recent gains to losses on a 0–100 scale. "Oversold" is not a buy signal — in a strong downtrend RSI can sit under 30 for weeks while price keeps falling.</p>
        <p class="kb-warn">All of them are arithmetic on past prices. None contains information about the future, and this site tested eight such rules across 72 combinations without one surviving out of sample. They are useful for <em>describing</em> conditions and sizing stops. They are not forecasts.</p>`,
        source: 'definitional, plus this site\'s own 72-combination search' };
    },
  },
  {
    id: 'spread', kind: 'mechanical',
    q: 'How much do spread and costs actually matter?',
    keys: ['spread', 'cost', 'commission', 'slippage', 'swap', 'overnight', 'fees', 'broker'],
    answer() {
      return { body: `
        <p>They matter most where people notice them least: the tighter your stop, the larger your cost as a share of risk.</p>
        <p>A 1-pip spread on a 20-pip stop is <strong>5% of your risk, gone before the trade starts</strong>. On a 5-pip stop it is 20%. Scalping does not reduce cost; it multiplies it, because cost is per trade and your edge per trade is smaller.</p>
        <p>Every backtest on this site charges cost on every trade, and each card shows spread as a percentage of risk for exactly this reason. A strategy that is profitable before costs and unprofitable after is not a strategy.</p>
        <p>Holding overnight adds financing (swap), which can run either way and compounds on multi-day positions.</p>`,
        source: 'arithmetic; costProfile on each signal' };
    },
  },
  {
    id: 'drawdown', kind: 'mechanical',
    q: 'What should I know about drawdown and losing streaks?',
    keys: ['drawdown', 'losing streak', 'risk of ruin', 'blow up', 'recovery', 'how many losses', 'variance', 'psychology'],
    answer() {
      return { body: `
        <p>Recovery is asymmetric, and badly so:</p>
        <table class="kb-t"><tr><th>drawdown</th><th>gain needed to recover</th></tr>
        <tr><td>10%</td><td>11%</td></tr><tr><td>25%</td><td>33%</td></tr>
        <tr><td>50%</td><td><strong>100%</strong></td></tr><tr><td>75%</td><td><strong>300%</strong></td></tr></table>
        <p>On streaks: at a 45% win rate, a run of 8 losses in 100 trades is <em>expected</em>, not evidence anything broke. Most systems are abandoned during a drawdown that was well within their normal range — the maths of the system was fine and the person could not sit through it.</p>
        <p>Which is why the interval around a result matters more than the result. A measured +0.1R with an interval spanning [−0.2, +0.4] cannot tell you whether a losing run is bad luck or a dead edge.</p>`,
        source: 'arithmetic' };
    },
  },
  {
    id: 'news', kind: 'mechanical',
    q: 'How should I handle news events?',
    keys: ['news', 'nfp', 'non-farm', 'nonfarm', 'economic calendar', 'event', 'release', 'announcement', 'cpi', 'rate decision', 'fomc'],
    answer(S) {
      const v = S && S.marketVoice;
      const cal = (v && v.calendar) || [];
      return { body: `
        <p>A scheduled release is the one market event whose <em>timing</em> is known exactly in advance. A stop placed on chart structure has no idea a rate decision is eleven minutes away, and normal-conditions sizing is not sized for a repricing.</p>
        <p>This site blocks publication within 30 minutes of a high-impact release and warns within 60. That is not a prediction of the number or the direction — only the arithmetic that a stop sized for normal conditions is not sized for that.</p>
        ${cal.length ? `<p><strong>Next scheduled:</strong> ${cal.slice(0, 3).map(e => `${KB_ESC(e.country)} ${KB_ESC(e.title)} in ${KB_ESC(e.hoursAway)}h`).join(' · ')}</p>`
          : `<p><strong>Nothing visible ahead.</strong> The calendar feed publishes the current week only, so from the last release of a week until it rolls over there is no forward visibility. The gate reports that as <em>unverified</em> rather than <em>clear</em> — it will not tell you a window is safe when it cannot see.</p>`}`,
        source: 'tools/news-gate.mjs and the Forex Factory calendar' };
    },
  },
  {
    id: 'overfitting', kind: 'mechanical',
    q: 'Why do backtests look so much better than live results?',
    keys: ['overfit', 'backtest look', 'curve fit', 'why do backtests', 'out of sample', 'data mining', 'too good'],
    answer(S) {
      const t = S && S.strategyTrials;
      return { body: `
        <p>Four reasons, and this site has been caught by every one of them:</p>
        <ul class="kb-l">
        <li><strong>Choosing on the data you measure on.</strong> ${t ? `Here: ${KB_ESC(t.hypotheses)} combinations tested, the best scoring t=5.26 in training and t=0.26 on data it had never seen.` : 'A rule picked from the same data that scores it will always look good.'}</li>
        <li><strong>Multiple testing.</strong> Try 72 rules at the usual 5% bar and roughly 4 pass by luck alone. The bar must be corrected for how many you tried${t ? ` — here <code>|t| &gt; ${KB_ESC(t.bonferroniBarT)}</code>` : ''}.</li>
        <li><strong>Overlapping observations.</strong> Hold 252 days and step 5, and consecutive trades share 98% of their outcome. A "10,000 trade" sample can behave like a few hundred.</li>
        <li><strong>Optimistic bar mechanics.</strong> If a bar touches both your stop and your target, assuming the target came first manufactures returns you could never have taken. This site assumes the stop.</li>
        </ul>
        <p>The honest defence is a sealed set opened once, a null to beat, and publishing the failures. That is why this page shows what did <em>not</em> work.</p>`,
        source: 'data/strategy-trials.json and this project\'s own corrected errors' };
    },
  },

  /* ═══ HONEST REFUSALS ══════════════════════════════════════════════════ */
  {
    id: 'refuse-predict', kind: 'refusal',
    q: 'Will this trade win? What will price do?',
    keys: ['will it win', 'will this win', 'trade win', 'this trade', 'price go', 'prediction', 'predict', 'forecast', 'should i buy', 'should i take', 'is this a good trade', 'guarantee', 'sure thing', 'best pair to trade', 'what should i trade', 'make money', 'profit'],
    answer(S) {
      const b = kbBrain(S);
      const ev = b && (b.measures?.everySignal || b.headline);
      return { body: `
        <p><strong>I cannot answer that, and anything that does is guessing.</strong></p>
        <p>No measurement on this site establishes an edge. ${ev ? `The live book reads ${KB_ESC(kbSign(ev.avgR) + ev.avgR)}R per signal with an interval of [${KB_ESC(ev.ci?.join(', '))}] — which includes zero.` : ''} 72 strategy combinations were tested over 20+ years of bars and none survived a sealed test; random entry beat the best of them.</p>
        <p>What I can tell you instead, and these are real:</p>
        <ul class="kb-l">
        <li>what this setup risks and pays if it runs — the ladder arithmetic is exact</li>
        <li>whether a scheduled release sits inside its window</li>
        <li>how similar setups have resolved historically, when enough independent episodes exist to say</li>
        <li>what the wider market is doing right now</li>
        </ul>
        <p>Deciding whether to take it is yours. I would be lying if I pretended otherwise.</p>`,
        source: 'the measured record, which does not support a prediction' };
    },
  },
];

/* ── matching ───────────────────────────────────────────────────────────
   Scored overlap rather than exact phrasing, because a question you have to
   word correctly is a search box, not an answer. Three rules learned from
   getting it wrong:

   · A WHOLE-PHRASE key outweighs loose word overlap. "what is your win rate"
     was routing to the expectancy explainer because both topics list "win
     rate"; the site-context words ("your", "this site") now decide it.
   · THERE IS A FLOOR. Below it, nothing is returned. "what is the weather in
     paris" used to match a topic on incidental word overlap, and a confident
     answer to a question I cannot answer is the worst output available.
   · SHORT WORDS DO NOT VOTE. Matching on "the", "does", "what" is noise.
   ---------------------------------------------------------------------- */
const KB_FLOOR = 6;
const KB_MIN_KEY = 6;        // an unambiguous short key still clears the floor          // below this, say "I do not know" instead
const KB_STOP = new Set(['what','when','where','which','does','this','that','with','your','about','from','have','been','will','should','there','their','they','them','than','then','like','just','some','also','into','over','only','very','much','many','more','most','such','here','make','made','know','tell','explain','mean','means']);
const KB_SELF = ['your','this site','this website','you ','the site','the website','here','our'];

function kbSearch(query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const selfish = KB_SELF.some(k => q.includes(k));

  const scored = TOPICS.map(t => {
    let score = 0;
    // Key hits dominate. A key is weighted by length, but never below
    // KB_MIN_KEY: "adx" and "nfp" are three characters and completely
    // unambiguous, and scoring them by length alone put them under the floor.
    for (const k of t.keys) {
      if (!q.includes(k)) continue;
      const whole = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(q);
      if (!whole && k.length < 5) continue;         // avoid 'r' matching inside 'risk'
      score += Math.max(k.length, KB_MIN_KEY) * (k.includes(' ') ? 2 : 1);
    }
    // loose word overlap, stop-words excluded
    for (const w of q.split(/[^a-z0-9%]+/)) {
      if (w.length < 4 || KB_STOP.has(w)) continue;
      if (t.keys.some(k => k === w)) score += 4;
      else if (t.keys.some(k => k.includes(w))) score += 1.5;
      if (t.q.toLowerCase().includes(w)) score += 2;
    }
    // "your win rate" is a question about THIS site, not about the concept
    if (selfish && t.kind === 'measured') score *= 1.6;
    return { t, score };
  }).filter(x => x.score >= KB_FLOOR).sort((a, b) => b.score - a.score);

  return scored.map(x => x.t);
}

window.FSKB = { TOPICS, search: kbSearch, esc: KB_ESC };

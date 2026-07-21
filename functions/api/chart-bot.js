// /api/chart-bot — Chart-reading + trade-decision analyst.
//
// Two modes:
//   1. LLM mode  — when ANTHROPIC_API_KEY is bound, calls Claude with full
//      multi-modal context (text + chart screenshots) + the live brain stats
//      pulled from KV. Returns a thorough analyst response with explicit
//      BUY / SELL / HOLD verdict, entry / SL / TP suggestions, and the
//      brain's backtested probability.
//   2. Brain-only — when no API key, runs a deterministic analyst that
//      parses the user's pair/direction, fetches the brain's stats for that
//      pair, and returns a structured verdict using the existing maths.
//
// Wire the key with: wrangler pages secret put ANTHROPIC_API_KEY
//   (model used: claude-opus-4-7 — latest Opus)
//
// IMPORTANT: never claims certainty. Every verdict pairs the LLM read with
// the brain's real numbers so the user sees both the model's reasoning AND
// the historical backtest evidence.

const ANTHROPIC_VERSION = '2023-06-01';
const MODEL_ID = 'claude-opus-4-7';
// v287 — 8192 tokens lets the model run the full 3-pass framework + full
// strategy scan + verdict + invalidation without truncation.
const MAX_TOKENS = 8192;

// v354 — Cloudflare Workers AI fallback. When ANTHROPIC_API_KEY is missing
// or credit is empty, we route through env.AI (bound in wrangler.toml).
// Model choice: Llama 3.3 70B Instruct fp8-fast — Cloudflare's fastest
// large model, currently supported, 128k context. Runs on Cloudflare's
// GPU infra, no download.
const WORKERS_AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const WORKERS_AI_MAX_TOKENS = 2048;

import { TRADING_WISDOM } from './_trading-wisdom.js';

// v287 — Maximum-intelligence chart analyst. Three-pass framework: SEE
// (pure literal observations only) → STRATEGIES (run the full institutional
// playbook in parallel) → CONFLUENCE+VERDICT (with explicit entry trigger
// and invalidation conditions). Multiple-strategy scan covers SMC, ICT,
// Wyckoff, Elliott, Fibonacci, supply/demand, classical patterns,
// candlestick patterns, structural breaks, divergences, VWAP/EMA, volume.
// Force trigger-based entries and explicit invalidations so the user knows
// not just "what" but "when" and "what kills it".
const SYSTEM_PROMPT = `You are ForexSight Analyst — the most rigorous, multi-strategy chart analyst a retail trader can talk to. You have been trained by the desk to read price action the way institutional traders read it: structurally, statistically, with respect for the fact that markets are uncertain and that your job is to find HIGH-EVIDENCE setups, not to fabricate certainty.

The user trades forex, gold, indices, and crypto. They are connected to a backtesting brain that runs continuously and provides LIVE_MARKET (actual current chart state) and BRAIN STATS (real backtested pWin) in every prompt. You MUST use those numbers; never invent.

# CORE PRINCIPLES (never violate these)

1. **Markets are probabilistic.** Never claim certainty. Use probabilities ("65% pWin", "high conviction", "low conviction"). Cap any single-trade confidence at 90%.
2. **If unclear, say so.** If the screenshot is too small/blurry, the symbol/timeframe aren't readable, or you can't see enough bars, STOP. State exactly what's missing and ask one specific clarifying question. NEVER guess.
3. **No fake numbers.** Live price, swing levels, day's range — all come from the LIVE_MARKET block. Brain pWin and pattern WRs come from the BRAIN STATS block. If a number isn't in those blocks, you don't know it. Do not invent prices "based on the chart shape" — anchor everything to LIVE_MARKET.
4. **Vision can fail.** When reading a screenshot, your description of what you see could be wrong. Cross-check what you "see" against the LIVE_MARKET numbers. If they disagree (e.g. you say "price is at 2640" but LIVE_MARKET says 2650), TRUST LIVE_MARKET and FLAG the discrepancy in your output: "⚠️ Visual read disagrees with live data — trusting live."
5. **HOLD is a valid answer.** A high-quality "wait" is more profitable than a forced trade.
6. **Only cite indicators visible in the screenshot.** Do NOT claim "RSI shows divergence" if no RSI panel is in the image. Do NOT claim "MACD is bullish" if MACD isn't visible. If indicators aren't shown, say "no indicators visible — basing analysis on price action only."
7. **Pattern claims require evidence.** Do NOT say "head and shoulders" without three clear peaks (left shoulder lower than head, right shoulder lower than head). Do NOT say "double top" without two roughly equal peaks. Do NOT say "engulfing" without a body that fully covers the prior body. If criteria aren't met, do NOT claim the pattern.
8. **Refuse on insufficient input.** If the user provides NO pair hint AND no screenshot has a clearly visible symbol AND no pair is inferable from price level, REFUSE and ask: "Which instrument is this? I cannot identify it from the image alone."
9. **Timeframe is critical.** Trades planned for the wrong timeframe are catastrophic. If the user did not specify a timeframe and you cannot read it from the screenshot's interface (look for "1H", "4H", "5m" labels), ASK before giving a verdict.
10. **Math must be correct.** SL must be on the OPPOSITE side of entry from your TPs. For BUY: SL below entry, TPs above. For SELL: SL above entry, TPs below. TP1 < TP2 < TP3 for BUY; TP1 > TP2 > TP3 for SELL. R:R must be honest — if you claim TP1 is 1.0R, the distance from entry to TP1 must equal the distance from entry to SL within 5%.

# THE THREE-PASS FRAMEWORK
You MUST run all three passes in order. Do not skip. Do not merge.

## PASS 1 — SEE (pure observation, zero interpretation)
Describe ONLY what is literally visible:
- Instrument symbol / inferred symbol
- Timeframe (read from screen if visible)
- Approximate price range visible
- Current price (use LIVE_MARKET value as ground truth)
- Last 5 candles: their direction, body size relative to range, any obvious wicks (long upper = rejection from above; long lower = rejection from below)
- Any visible drawings: trendlines, support/resistance levels, Fibs, channels
- Any visible indicators: EMAs, RSI, MACD, VWAP, volume
- Today's range: open / high / low (from LIVE_MARKET)
- Recent swing high and swing low (from LIVE_MARKET)
DO NOT say "this is bullish" yet. Just observe.

## PASS 2 — STRATEGY SCAN (run all of these in parallel; mark each as TRIGGERED / IDLE / NOT APPLICABLE)
For each strategy below, decide if its setup is present and which side it favors:

### Smart Money Concepts (SMC)
- **Order Block (OB):** The last opposing candle before an impulsive move. Did price recently break structure and is now returning to mitigate an OB?
- **Fair Value Gap (FVG):** A 3-candle pattern where candle 1's high is below candle 3's low (or inverse for bearish). Is price returning to fill an FVG?
- **Break of Structure (BOS):** Has price taken out the last opposing swing? (BOS up = bullish; BOS down = bearish.)
- **Change of Character (CHOCH):** First counter-trend BOS — signals a regime shift.
- **Liquidity grab:** Has price swept a recent swing high/low and reversed? (Classic stop-hunt before a real move.)

### ICT (Inner Circle Trader)
- **Killzone:** Is the current time within London (07-10 GMT) or NY (12-16 GMT) killzone? (Live news block tells you the time-relevant events.)
- **Breaker block:** A failed order block (price broke through it) that becomes opposing S/R on retest.
- **Mitigation block:** Untested OB that price is approaching for the first time.
- **Draw on liquidity:** Where is the most obvious pool of stops (equal highs / equal lows / round number)? Price tends to draw toward it.

### Wyckoff
- **Accumulation:** Sideways consolidation after a downtrend with declining volume and a "spring" (false break below).
- **Distribution:** Sideways consolidation after an uptrend with an "upthrust" (false break above).
- **Spring/upthrust:** False break of support/resistance that immediately reverses — a high-probability reversal signal.

### Elliott Wave (only if clear; do not force-count)
- **Impulse (5-wave):** Currently in wave 1, 3, 5 of an impulse or in an ABC correction?
- **Wave 3 extensions:** Wave 3 typically the longest and most tradeable.
- **Wave 5 divergence:** RSI/MACD divergence in wave 5 often warns of reversal.
- If wave count is ambiguous, mark NOT APPLICABLE.

### Fibonacci
- From the most recent significant swing (low → high for downtrend retracement, etc.), where is price relative to:
  - 0.382 (shallow retracement, strong trend)
  - 0.500 (moderate)
  - 0.618 (Golden — most institutional entry zone)
  - 0.786 (deep — last viable retracement before invalidation)
- Is there confluence between a Fib level and an OB / FVG / structure level?

### Supply & Demand zones
- Where is the nearest fresh demand zone (untested) below current price?
- Where is the nearest fresh supply zone above?
- Is price reacting to one right now?

### Classical patterns
Scan for: head & shoulders / inverse H&S, double top / double bottom, triangles (ascending / descending / symmetric), flags, pennants, wedges (rising / falling), cup & handle. If a pattern is forming OR completed, note it.

### Candlestick patterns at key levels (only if at a real level)
- **Bullish:** hammer, bullish engulfing, morning star, piercing line, three white soldiers
- **Bearish:** shooting star, bearish engulfing, evening star, dark cloud, three black crows
- **Indecision at extremes:** doji at a level = warning

### Market structure (price action)
- Series of HH/HL = uptrend; LH/LL = downtrend; mixed = range.
- Is price at the top, middle, or bottom of the current structure?

### Divergences (only if RSI/MACD visible or implied by price)
- **Regular bullish:** price LL, indicator HL → reversal up likely.
- **Regular bearish:** price HH, indicator LH → reversal down likely.
- **Hidden bullish/bearish:** continuation signals.

### Dynamic levels
- Is price respecting the 20/50/200 EMA?
- Is price above/below VWAP (intraday)?
- Round numbers (e.g. 2650, 4250) are magnetic — note proximity.

### Volume (if visible)
- Volume spike on breakout = confirmation.
- Volume drying up at level = potential reversal.
- **VSA (Volume Spread Analysis):** No supply (small down candle, low volume) at support = strong bull signal. No demand (small up candle, low volume) at resistance = strong bear signal.

### Ichimoku Cloud (v341)
- **Price ABOVE cloud + tenkan > kijun + cloud bullish (green):** strong uptrend
- **Price BELOW cloud + tenkan < kijun + cloud bearish (red):** strong downtrend
- **Price INSIDE cloud:** no trade zone (choppy, avoid)
- **Cloud twist ahead:** upcoming trend change signal
- **Kumo breakout:** price closing outside cloud after being inside = high-probability breakout
- **Chikou span (26 bars back):** should be above/below price + all other components for maximum signal strength

### Institutional Order Flow Proxies (v341)
- **Absorption:** Large candle that stalls at level = big orders being absorbed
- **Exhaustion gap:** Gap in the direction of trend that immediately reverses = trend done
- **Trapped traders:** Sharp reversal from a breakout = traders trapped, price often accelerates the other way (2-3× the breakout distance)
- **Anchored VWAP from key event:** Price above anchored VWAP (from major low) = bullish institutional bias

### Round-Number Magnetism (v341)
- **Level 00 (e.g. 65000):** Whole number, strong psychological level
- **Level 50 (e.g. 65500):** Half level, secondary magnetism
- **Fib × round number confluence:** 61.8% retracement lands on 65000 = double edge zone
- Price WILL retest these levels — plan around them, not against them

### News Reactivity (v341)
- **First 15 minutes after high-impact news:** avoid entries — direction can whipsaw
- **News candle rejection:** if the news candle wick got faded back, that faded direction is the play
- **Pre-news drift:** price often drifts opposite to expected news impact then reverses hard

### Failed Pattern = Signal (v341)
- **Failed H&S neckline break:** if price breaks below H&S neckline then reclaims, LONG the reclaim (higher probability than the pattern itself)
- **Failed double top rally:** if price makes new low after "invalidating" a double top, SHORT that trap
- **Failed breakout:** most breakouts fail. If you see one fail (return inside range), FADE it with the range as your zone

## PASS 3 — CONFLUENCE & VERDICT
Tally the strategy scan. For a BUY:
- HTF (from LIVE_MARKET) is UP or RANGE-low
- BOS up / OB hold / FVG fill in price's favor
- Fib 0.5-0.618 retracement holds
- Bullish candlestick at a key level
- Brain pWin ≥ 55% on this pair
- No high-impact news in next 60 minutes against the trade
- R:R ≥ 2:1 with the structural stop

**Verdict thresholds:**
- 0–2 confluences → HOLD
- 3–4 confluences → BUY/SELL but confidence capped at 70%
- 5–6 confluences AND brain pWin ≥ 60% → BUY/SELL up to 80%
- 7+ confluences AND brain pWin ≥ 65% → BUY/SELL up to 88%
- Never above 90% confidence.

**Entry trigger** — DO NOT say "enter now" unless price is literally at the trigger point. Specify the CONDITION that must occur for entry:
- "Enter on retest of [zone] with bullish 1H engulfing close"
- "Enter on break-and-retest of [resistance] holding as support"
- "Enter on 0.618 Fib tap with 5-min bullish wick rejection"
- "Enter on stop-hunt of [low] followed by reclaim"

**Invalidation** — state the SPECIFIC condition that proves the verdict wrong:
- "1H close below [swing low] invalidates this setup"
- "Break of the demand zone at [price] = abandon"

# OUTPUT FORMAT — use exactly this structure for trade questions

**🧭 What I see on the chart**
[3-5 line literal observation from PASS 1]

**🔬 Strategy scan**
- **SMC:** [BOS / OB / FVG / liquidity grab — state which apply, side]
- **ICT:** [killzone / breaker / mitigation / draw on liquidity]
- **Wyckoff:** [accumulation / distribution / spring / N/A]
- **Elliott:** [wave count if clear, else N/A]
- **Fib:** [position relative to recent swing's Fib levels]
- **Supply/Demand:** [nearest zones above/below]
- **Classical:** [pattern if present, else none]
- **Candlestick:** [pattern at level, if any]
- **Structure:** [HH/HL trend reading]
- **Divergence:** [if visible, else N/A]
- **Dynamic levels:** [EMA / VWAP / round-number proximity]
- **Volume:** [if visible]

**📊 Confluences (X / 7):**
- ✅ or ❌ HTF aligned
- ✅ or ❌ Multi-strategy confluence (≥2 of SMC/ICT/Wyckoff trigger same side)
- ✅ or ❌ At key Fib + structure confluence
- ✅ or ❌ Bullish/bearish candlestick at level
- ✅ or ❌ Brain pWin ≥ 55%
- ✅ or ❌ No imminent high-impact news
- ✅ or ❌ R:R ≥ 2:1

**⚖️ Verdict:** BUY / SELL / HOLD
**Pair:** [symbol]
**Live price:** [exact from LIVE_MARKET]

**🎯 Entry:** [exact price]
**🚦 Entry trigger:** [the SPECIFIC condition that must occur — never "now" unless price is at trigger]
**🛡️ Stop Loss:** [exact price] ([X] pips, justified: "below the demand zone at X" / "above the OB high at X")
**💰 TP1:** [price] (1.0R) / **TP2:** [price] (2.0R) / **TP3:** [price] (3.0R or HTF target)

**📈 Confidence:** [X]%
**🧠 Brain pWin:** [X]% from [N] backtested samples in current regime
**🔑 Why this works:** One sentence — the single strongest confluence.
**❌ Invalidation:** "1H close below/above [exact price] kills this trade — abandon immediately."
**👀 Watch out:** One sentence — the most likely thing that ruins this trade (news, low liquidity, false breakout, etc.).
**📋 Management plan:** Specific instructions ("Take 30% off at TP1, move SL to break-even, trail behind 1H swing for runners").

# v353 — USE THESE VERIFIED FACTS (100x smarter mode)
The prompt now includes seven verified-fact blocks fetched live from public APIs and our own deterministic system. Treat them as GROUND TRUTH — they beat visual reads when they disagree.

- **MULTI_SOURCE** — VIX, DXY, US 10Y, Gold/Silver ratio, Crypto Fear&Greed, BTC dominance with per-direction BUY/SELL verdicts (VETO/CAUTION/NEUTRAL/CONFIRM). If MULTI_SOURCE verdict is **VETO for your direction**, you MUST NOT recommend that direction — downgrade to HOLD and cite the vetoing indicator.
- **PREDICT_NEXT** — deterministic weighted consensus of 8+ factors (trend, momentum, structure, volatility, correlation, session, news, brain). Its direction is the SYSTEM CONSENSUS. Your visual read should AGREE. If you disagree, name the specific bearish/bullish factor from its list you're overriding and why.
- **CHART_PULSE** — regime, trend, RSI, ADX, position in day range, distance to swings, last-5-candle bias for this pair, updated every cron cycle. If ADX < 20, the market is CHOPPY — do not recommend trend continuations.
- **VETO_STATUS** — pair+direction currently BLOCKED due to recent losing streak. If a direction is blocked, you MUST recommend HOLD for that direction (or the opposite side).
- **WINNING_PATTERNS** — Wilson-lower-bound ≥55% WR proven-winner combos for this pair. If your setup matches one, cite it as extra confluence. If your setup contradicts a proven winner, explain the divergence.

Alignment rule: PREDICT_NEXT direction + MULTI_SOURCE non-VETO + VETO_STATUS not-blocked = highest-conviction setups (up to 88% confidence). Any single misalignment caps confidence at 70%. Two or more misalignments → HOLD.

# Final SELF-CHECK before you output
Ask yourself FIVE questions:
1. Did I cite real numbers from LIVE_MARKET and BRAIN STATS, not invented ones?
2. Did I list confluences from real strategy triggers in PASS 2, not vibes?
3. Did I check MULTI_SOURCE, PREDICT_NEXT, VETO_STATUS, and WINNING_PATTERNS before committing to a direction?
4. Is my verdict aligned with PREDICT_NEXT direction? If not, did I name the specific factor I'm overriding?
5. If I had £10,000 to risk on this trade, would I take it with these exact levels?
If the answer to any is NO, downgrade the verdict to HOLD and explain why.

# Non-market questions
If the user asks something not related to a chart/trade, answer briefly (under 3 lines) and gently pivot: "Do you have a chart you'd like me to analyse?"

# Tone
Direct, structured, surgical. No fluff. No "great question!" No emojis except the section markers above. The user is on a phone and trading real money — every word must earn its place.

${TRADING_WISDOM}`;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400); }

  const messages = Array.isArray(body.messages) ? body.messages : [];
  const pairHint = (body.pair || '').toString().trim();
  const timeframeHint = (body.timeframe || '').toString().trim();
  // v290 — Optional Live Chart inputs: strategy focus, indicator selections,
  // asset class, expert-mode custom prompt. All forwarded into the prompt
  // augmentation so Claude focuses correctly.
  const strategyHint = (body.strategy || '').toString().trim();
  const indicatorHints = Array.isArray(body.indicators) ? body.indicators.slice(0, 3) : [];
  const assetClassHint = (body.assetClass || '').toString().trim();
  const expertPrompt = (body.expertPrompt || '').toString().trim().slice(0, 2000);
  if (!messages.length) return json({ error: 'messages array required' }, 400);

  // ─────────────────────────────────────────────────────────────────────
  // v286 — Fetch live brain stats + LIVE OHLC + upcoming news in parallel.
  // The bot now sees the actual current chart state and pending events,
  // not just whatever the user typed. Much sharper analysis.
  // ─────────────────────────────────────────────────────────────────────
  const origin = new URL(request.url).origin;
  // v291 — Five parallel fetches: brain, live market, news, multi-TF context,
  // and recent verdict memory for the same pair. Every prompt is now armed
  // with deterministically-computed technicals + multi-timeframe context +
  // the bot's own recent calls on this instrument.
  // v293/v294 — Seven parallel fetches: brain, live market, calendar, multi-TF,
  // verdict memory, per-currency news sentiment, AND correlated-instrument
  // cross-validation (DXY, 10Y yields, silver, SPX, etc. depending on pair).
  // Every analysis is now grounded in real news bias AND real correlated
  // market moves.
  // v353 — 7 additional intelligence sources injected as facts (100x smarter):
  // multi-source (VIX/DXY/F&G), predict-next consensus, chart-pulse regime,
  // veto status, winning-pattern match, live-analysis tier verdict, tp-status.
  const [brainContext, liveMarket, upcomingNews, multiTF, recentVerdicts, newsSentiment, correlation, multiSource, predictNext, chartPulse, vetoStatus, winningPatterns] = await Promise.all([
    _gatherBrainContext(env, pairHint),
    _gatherLiveMarket(origin, pairHint),
    _gatherUpcomingNews(origin, pairHint),
    _gatherMultiTF(origin, pairHint),
    _loadRecentVerdicts(env, pairHint),
    _gatherNewsSentiment(origin, pairHint),
    _gatherCorrelation(origin, pairHint),
    // v353 additions
    pairHint ? fetch(`${origin}/api/multi-source-check?pair=${encodeURIComponent(pairHint)}&direction=BOTH`).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
    pairHint ? fetch(`${origin}/api/predict-next?pair=${encodeURIComponent(pairHint)}`).then(r => r.ok ? r.json() : null).catch(() => null) : Promise.resolve(null),
    fetch(`${origin}/api/chart-pulse`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${origin}/api/veto-status`).then(r => r.ok ? r.json() : null).catch(() => null),
    fetch(`${origin}/api/winning-patterns`).then(r => r.ok ? r.json() : null).catch(() => null),
  ]);
  brainContext.liveMarket = liveMarket;
  brainContext.upcomingNews = upcomingNews;
  brainContext.timeframe = timeframeHint || null;
  brainContext.strategy = strategyHint || null;
  brainContext.indicators = indicatorHints;
  brainContext.assetClass = assetClassHint || null;
  brainContext.expertPrompt = expertPrompt || null;
  brainContext.multiTF = multiTF;
  brainContext.recentVerdicts = recentVerdicts;
  brainContext.newsSentiment = newsSentiment;
  brainContext.correlation = correlation;
  // v353 — 7 new intelligence sources attached as facts for the LLM
  brainContext.multiSource = multiSource;
  brainContext.predictNext = predictNext;
  brainContext.chartPulse = chartPulse;
  brainContext.vetoStatus = vetoStatus;
  brainContext.winningPatterns = winningPatterns;

  // Build the conversation. Always inject the brain stats into the LAST
  // user message so the model sees both the chat AND the backtest reality.
  const turnsForApi = _trimContext(messages);
  const lastUserIdx = _findLastUserIndex(turnsForApi);
  if (lastUserIdx >= 0) {
    turnsForApi[lastUserIdx] = _augmentUserTurn(turnsForApi[lastUserIdx], brainContext);
  }

  // ─────────────────────────────────────────────────────────────────────
  // LLM mode — Anthropic API call.
  // ─────────────────────────────────────────────────────────────────────
  if (env.ANTHROPIC_API_KEY) {
    try {
      const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODEL_ID,
          max_tokens: MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: turnsForApi.map(_toAnthropicMessage),
        }),
      });
      if (!apiRes.ok) {
        const errText = await apiRes.text().catch(() => '');
        const isCreditEmpty = /credit balance/i.test(errText);
        // v354 — Try Workers AI (Llama 3.1 8B on Cloudflare's GPUs, free
        // tier 10k neurons/day) BEFORE falling back to brain-only. The
        // trading wisdom + verified facts are baked into the system prompt
        // so even the smaller model produces institutional-quality reads.
        const workersReply = await _tryWorkersAI(env, turnsForApi, brainContext);
        if (workersReply) {
          return json({
            mode: 'workers-ai-fallback',
            model: WORKERS_AI_MODEL,
            reply: workersReply,
            brainContext,
            upstreamStatus: apiRes.status,
            note: isCreditEmpty
              ? `Anthropic credit empty — served by Cloudflare Workers AI (${WORKERS_AI_MODEL}) with full trading wisdom + verified facts.`
              : `Anthropic transient error — served by Cloudflare Workers AI (${WORKERS_AI_MODEL}) fallback.`,
          });
        }
        // v300 — Final graceful degradation. When both LLMs fail, serve
        // brain-only analysis so the client always renders something.
        const brainReply = _brainOnlyReply(messages, brainContext);
        return json({
          mode: isCreditEmpty ? 'brain-only-credit-empty' : 'brain-only-llm-error',
          model: null,
          reply: brainReply,
          brainContext,
          upstreamStatus: apiRes.status,
          upstreamError: errText.slice(0, 300),
          workersAIDebug: globalThis.__workersAIDebug || null,
          setupHint: isCreditEmpty
            ? 'Add Anthropic credit at https://console.anthropic.com/settings/billing to unlock full LLM analysis. Brain + Workers AI fallback both attempted.'
            : 'Anthropic API returned a temporary error — brain-only served instead.',
        }, 200);
      }
      const data = await apiRes.json();
      let reply = (data.content || [])
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      // v288 — Server-side verdict validator. Catches math/geometry errors
      // that the LLM is prone to (wrong R:R, SL on wrong side, TPs out of
      // order, entry far from live price without an explicit trigger).
      const validation = _validateVerdict(reply, brainContext.liveMarket);
      if (validation.warnings.length) {
        reply += '\n\n---\n**⚠️ Validator caught issues — review before trading:**\n' +
          validation.warnings.map(w => `- ${w}`).join('\n');
      }
      // v291 — Save the verdict to KV for next-call continuity. Persists
      // the parsed fields so the bot can later see "I called BUY at X
      // yesterday — is it still valid?".
      try {
        if (validation.parsed && validation.parsed.verdict && validation.parsed.verdict !== 'HOLD') {
          await _saveVerdict(env, pairHint, {
            verdict: validation.parsed.verdict,
            entry: validation.parsed.entry,
            sl: validation.parsed.sl,
            tp1: validation.parsed.tp1,
            tp2: validation.parsed.tp2,
            tp3: validation.parsed.tp3,
            confidence: validation.parsed.confidence,
            strategy: strategyHint || null,
            timeframe: timeframeHint || null,
            livePxAtTime: brainContext.liveMarket?.livePrice || null,
          });
        }
      } catch {}
      return json({
        mode: 'llm',
        model: MODEL_ID,
        reply,
        brainContext,
        validation,
        usage: data.usage || null,
        stopReason: data.stop_reason || null,
      });
    } catch (e) {
      return json({
        mode: 'llm-exception',
        error: String(e.message || e).slice(0, 500),
        brainContext,
        fallbackReply: _brainOnlyReply(messages, brainContext),
      }, 200);
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // v354 — No Anthropic key? Try Workers AI (Llama 3.1 8B, free tier).
  // ─────────────────────────────────────────────────────────────────────
  const workersReply = await _tryWorkersAI(env, turnsForApi, brainContext);
  if (workersReply) {
    return json({
      mode: 'workers-ai-primary',
      model: WORKERS_AI_MODEL,
      reply: workersReply,
      brainContext,
      note: `No Anthropic key configured — served by Cloudflare Workers AI (${WORKERS_AI_MODEL}) with baked-in institutional trading wisdom.`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // Brain-only mode — deterministic analyst using stats only.
  // ─────────────────────────────────────────────────────────────────────
  return json({
    mode: 'brain-only',
    reply: _brainOnlyReply(messages, brainContext),
    brainContext,
    setupHint: 'Set ANTHROPIC_API_KEY via `wrangler pages secret put ANTHROPIC_API_KEY` to enable full LLM analysis with chart reading.',
  });
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}

// v354 — Cloudflare Workers AI fallback (Llama 3.1 8B Instruct).
// Runs on Cloudflare's GPU infrastructure — no download, no size limit,
// free tier 10k neurons/day. Called when Anthropic is unavailable so
// the chart bot never has to fall through to brain-only text.
//
// The system prompt is the same SYSTEM_PROMPT that Anthropic sees, but
// Llama's 8K context window forces us to trim: we keep the CORE PRINCIPLES,
// the strategy scan, the OUTPUT FORMAT, and the verified-fact rules,
// and drop the deep wisdom appendix (still available via the wisdom file
// if needed). Also strip image content from turns — Llama-3-8B-Instruct
// is text-only.
async function _tryWorkersAI(env, turnsForApi, brainContext) {
  if (!env || !env.AI || typeof env.AI.run !== 'function') {
    globalThis.__workersAIDebug = { skipped: 'binding-missing' };
    return null;
  }
  try {
    const systemPrompt = _buildWorkersAIPrompt(brainContext);
    const messages = [{ role: 'system', content: systemPrompt }];
    // Flatten to text-only for Llama. Preserve the last augmented user turn
    // (which contains all the LIVE_MARKET / MULTI_SOURCE / PREDICT_NEXT
    // context blocks) — that's where the model gets its facts.
    for (const t of turnsForApi) {
      let text = '';
      if (typeof t.content === 'string') text = t.content;
      else if (Array.isArray(t.content)) {
        text = t.content
          .filter(p => p.type === 'text' || typeof p === 'string')
          .map(p => (typeof p === 'string' ? p : p.text))
          .join('\n');
        const hasImage = t.content.some(p => p.type === 'image');
        if (hasImage) {
          text = '[User attached a chart screenshot — I cannot see images in fallback mode; reasoning from live data + brain stats only]\n\n' + text;
        }
      }
      if (text.trim()) messages.push({ role: t.role || 'user', content: text.slice(0, 8000) });
    }
    const response = await env.AI.run(WORKERS_AI_MODEL, {
      messages,
      max_tokens: WORKERS_AI_MAX_TOKENS,
      temperature: 0.3, // low = more deterministic, more rule-following
    });
    const text = (response && (response.response || response.text || '')).toString().trim();
    if (!text || text.length < 20) {
      globalThis.__workersAIDebug = { emptyResponse: JSON.stringify(response).slice(0, 300) };
      return null;
    }
    return text;
  } catch (e) {
    globalThis.__workersAIDebug = { error: String(e.message || e).slice(0, 300) };
    return null;
  }
}

// Trimmed system prompt for the smaller Workers AI model. Keeps the rules
// that matter most for a phone-first retail trader: NEVER invent numbers,
// respect the verified-fact blocks, and use the OUTPUT FORMAT so the
// client's parser doesn't break.
function _buildWorkersAIPrompt(ctx) {
  return `You are ForexSight Analyst — a rigorous, multi-strategy chart analyst. Give the user the most honest read possible.

# CORE RULES (never violate)
1. Never claim certainty. Cap any single-trade confidence at 88%. Use HOLD when unclear.
2. Cite ONLY numbers from the LIVE_MARKET / MULTI_SOURCE / PREDICT_NEXT / CHART_PULSE / BRAIN_STATS blocks in the prompt. NEVER invent prices, WRs, or indicator values.
3. If MULTI_SOURCE verdict is VETO for a direction → recommend HOLD.
4. If VETO_STATUS blocks a pair+direction → recommend HOLD or opposite side.
5. Your recommended direction should ALIGN with PREDICT_NEXT direction. If you disagree, explain WHY specifically citing a bearish/bullish factor.
6. Math: BUY has SL < entry < TP1 < TP2 < TP3. SELL has SL > entry > TP1 > TP2 > TP3. R:R ≥ 2:1 minimum.

# STRATEGY PLAYBOOK — use these
- SMC: BOS, CHOCH, order blocks, FVGs, liquidity sweeps
- Wyckoff: accumulation/distribution, springs (highest-probability reversals — 72% WR)
- ICT: killzones (London 07-10 GMT / NY 12-16 GMT), silver bullet
- Bulkowski patterns: H&S (81% WR), Inv H&S (83%), ascending triangle (72%), bull flag (68%), cup&handle (71%)
- Al Brooks: H1/L1, wedges, failed breakouts (65% WR fading them)
- Fibonacci: 0.618 golden zone with S/R confluence
- ADX: <20 = range (mean-reversion), 20-25 = transitional, >25 = trend (trend-following)
- Volume: spike + big candle = institutional; spike + wick = rejection

# OUTPUT FORMAT — use exactly this structure for trade questions

**🧭 What I see on the chart**
[3-5 line literal read using LIVE_MARKET values]

**🔬 Strategy scan**
- SMC: [what triggered, side]
- Wyckoff: [phase or N/A]
- ICT: [killzone, FVG, etc.]
- Patterns: [any Bulkowski pattern present]
- Fib: [nearest key level]
- ADX regime: [trend/range]

**📊 Verified facts alignment**
- MULTI_SOURCE: [BUY/SELL verdicts from the block]
- PREDICT_NEXT: [direction + confidence from the block]
- VETO_STATUS: [any block?]
- WINNING_PATTERNS: [any matches?]

**⚖️ Verdict:** BUY / SELL / HOLD
**Pair:** ${ctx.pair || '[symbol]'}
**Live price:** [exact from LIVE_MARKET]

**🎯 Entry:** [price]
**🚦 Entry trigger:** [specific condition]
**🛡️ Stop Loss:** [price] (structural)
**💰 TP1:** [price] (1.0R) / **TP2:** [price] (2.0R) / **TP3:** [price] (3.0R)

**📈 Confidence:** [X]%
**🧠 Brain pWin:** [X]% from [N] samples
**🔑 Why this works:** [one sentence]
**❌ Invalidation:** [specific condition + price]
**👀 Watch out:** [one sentence]

# TONE
Direct, structured, surgical. No fluff. Every word must earn its place.`;
}

// Yahoo symbol mapping for live OHLC fetch — kept in sync with PAIRS in
// check-signals.js. Extended here to cover indices and crypto so the bot
// can pull live context for any common instrument.
const _SYM_MAP = {
  'XAU/USD': 'GC=F',
  'XAG/USD': 'SI=F',
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'NZD/USD': 'NZDUSD=X', 'USD/CAD': 'USDCAD=X',
  'USD/CHF': 'USDCHF=X',
  'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'US30': '^DJI', 'NAS100': '^NDX', 'SPX500': '^GSPC', 'GER40': '^GDAXI',
  'UK100': '^FTSE', 'JPN225': '^N225',
  'BTC/USD': 'BTC-USD', 'ETH/USD': 'ETH-USD',
};

// Pull the freshest brain snapshot + pair-specific stats from KV.
async function _gatherBrainContext(env, pairHint) {
  const ctx = {
    pair: pairHint || null,
    intelligenceLevel: null,
    currentRegime: null,
    samples: 0,
    topPatterns: [],
    pairStats: null,
    latestSignals: [],
    liveMarket: null,   // v286 — auto-fetched OHLC structure
    upcomingNews: [],   // v286 — calendar events
    notes: [],
  };
  if (!env.TRADES_KV) {
    ctx.notes.push('KV not bound — running without live brain context.');
    return ctx;
  }
  try {
    const raw = await env.TRADES_KV.get('learning-brain');
    if (raw) {
      const brain = JSON.parse(raw);
      ctx.intelligenceLevel = Math.round((brain.peakIntelligenceLevel || brain.intelligenceLevel || 0) * 100);
      ctx.currentRegime = brain.currentRegime?.regime || null;
      ctx.samples = brain.totalSamples || 0;
      // Top 5 cross-pair winning patterns. Filter out unrealistic 100% WR
      // entries — those come from backtest synthetic samples with not enough
      // adversarial losses. A real edge in markets sits in 55-75% WR; cap
      // displayed WR at 80% and require some losses so we don't mislead the
      // user with "perfect" patterns that will lose on live.
      if (brain.byCombo) {
        ctx.topPatterns = Object.entries(brain.byCombo)
          .map(([k, v]) => ({ combo: k, w: v.w || 0, l: v.l || 0, n: (v.w || 0) + (v.l || 0) }))
          .filter(x => x.n >= 50 && x.l >= 5)  // real distribution required
          .map(x => ({ ...x, wr: Math.round(100 * x.w / x.n) }))
          .filter(x => x.wr <= 80)              // discard suspicious perfect-runs
          .sort((a, b) => b.wr - a.wr)
          .slice(0, 5);
      }
      // Pair-specific snapshot if we know the pair
      if (pairHint && brain.byPair && brain.byPair[pairHint]) {
        const p = brain.byPair[pairHint];
        const topCombos = Object.entries(p.byCombo || {})
          .map(([k, v]) => ({ combo: k, w: v.w || 0, l: v.l || 0, n: (v.w || 0) + (v.l || 0) }))
          .filter(x => x.n >= 20 && x.l >= 2)
          .map(x => ({ ...x, wr: Math.round(100 * x.w / x.n) }))
          .filter(x => x.wr <= 80)
          .sort((a, b) => b.wr - a.wr)
          .slice(0, 3);
        ctx.pairStats = {
          totalSamples: p.totalSamples || 0,
          topCombos,
        };
      }
    }
  } catch (e) {
    ctx.notes.push('Brain snapshot unreadable: ' + e.message);
  }
  // Most recent live signals (last 5) for context
  try {
    const raw = await env.TRADES_KV.get('latest-signals');
    if (raw) {
      const data = JSON.parse(raw);
      ctx.latestSignals = (data.signals || []).slice(0, 5).map(s => ({
        pair: s.pair, direction: s.direction, confidence: s.confidence,
        entry: s.entry, sl: s.sl, tp1: s.tp1,
        pWin: s.probabilityAnalysis?.pWin || null,
      }));
    }
  } catch {}
  return ctx;
}

// ════════════════════════════════════════════════════════════════════════
// v291 — DETERMINISTIC TECHNICAL INDICATORS. Computed server-side from OHLC
// closes/highs/lows so the bot gets hard numbers instead of estimating from
// the screenshot. Each function takes the bar arrays and returns the value
// at the most recent close. Tight ports of the standard formulas — no
// dependencies, no surprises. Used directly in the prompt context.
// ════════════════════════════════════════════════════════════════════════
function _ema(arr, period) {
  if (!arr || arr.length < period) return null;
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
  }
  return ema;
}
function _emaSeries(arr, period) {
  if (!arr || arr.length < period) return [];
  const out = Array(arr.length).fill(null);
  const k = 2 / (period + 1);
  let ema = arr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = ema;
  for (let i = period; i < arr.length; i++) {
    ema = arr[i] * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}
function _rsi(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}
function _macd(closes) {
  if (!closes || closes.length < 35) return null;
  const ema12 = _emaSeries(closes, 12);
  const ema26 = _emaSeries(closes, 26);
  if (!ema12.length || !ema26.length) return null;
  const macdLine = closes.map((_, i) =>
    (ema12[i] != null && ema26[i] != null) ? ema12[i] - ema26[i] : null);
  const macdValid = macdLine.filter(v => v != null);
  if (macdValid.length < 9) return null;
  const signal = _ema(macdValid, 9);
  const macdNow = macdLine[macdLine.length - 1];
  const histogram = macdNow - signal;
  return { line: macdNow, signal, histogram };
}
function _bollinger(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const mid = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const upper = mid + mult * sd;
  const lower = mid - mult * sd;
  const livePx = closes[closes.length - 1];
  const percentB = sd > 0 ? (livePx - lower) / (upper - lower) : 0.5;
  return { upper, mid, lower, percentB };
}
function _atr(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < highs.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}
function _adx(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < highs.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let tr14 = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let pdm14 = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let mdm14 = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dxList = [];
  for (let i = period; i < trs.length; i++) {
    tr14 = tr14 - (tr14 / period) + trs[i];
    pdm14 = pdm14 - (pdm14 / period) + plusDM[i];
    mdm14 = mdm14 - (mdm14 / period) + minusDM[i];
    const plusDI = (pdm14 / tr14) * 100;
    const minusDI = (mdm14 / tr14) * 100;
    const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI + 1e-9) * 100;
    dxList.push({ dx, plusDI, minusDI });
  }
  if (dxList.length < period) return null;
  const lastN = dxList.slice(-period);
  const adx = lastN.reduce((s, d) => s + d.dx, 0) / period;
  const last = dxList[dxList.length - 1];
  return { adx, plusDI: last.plusDI, minusDI: last.minusDI };
}
function _vwap(bars) {
  if (!bars || !bars.length) return null;
  let pvSum = 0, vSum = 0;
  for (const b of bars) {
    const typical = (b.h + b.l + b.c) / 3;
    const v = b.v || 1;
    pvSum += typical * v;
    vSum += v;
  }
  return vSum > 0 ? pvSum / vSum : null;
}

// ════════════════════════════════════════════════════════════════════════
// v291 — DETERMINISTIC PATTERN DETECTION. Identifies candlestick patterns
// on the most recent bar (and prior bar where 2-bar patterns require it).
// Stricter than the LLM's eyeball reading — only flags patterns whose
// formal criteria are met. Returns an array of pattern names.
// ════════════════════════════════════════════════════════════════════════
function _detectCandlePatterns(bars) {
  if (!bars || bars.length < 3) return [];
  const last = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const patterns = [];
  const body = Math.abs(last.c - last.o);
  const range = Math.max(1e-9, last.h - last.l);
  const upWick = last.h - Math.max(last.o, last.c);
  const dnWick = Math.min(last.o, last.c) - last.l;
  const isBull = last.c > last.o;
  const isBear = last.c < last.o;
  const prevBody = Math.abs(prev.c - prev.o);
  const prevIsBull = prev.c > prev.o;
  const prevIsBear = prev.c < prev.o;
  // Doji: tiny body relative to range
  if (body / range < 0.10) patterns.push('doji');
  // Hammer: small body at top, long lower wick (>2x body)
  if (isBull && dnWick > body * 2 && upWick < body * 0.6) patterns.push('hammer (bullish)');
  // Shooting star: small body at bottom, long upper wick (>2x body)
  if (isBear && upWick > body * 2 && dnWick < body * 0.6) patterns.push('shooting-star (bearish)');
  // Bullish engulfing: prev bearish small body, current bullish body engulfs prev
  if (prevIsBear && isBull && body > prevBody && last.o <= prev.c && last.c >= prev.o) {
    patterns.push('bullish-engulfing');
  }
  // Bearish engulfing: prev bullish small body, current bearish body engulfs prev
  if (prevIsBull && isBear && body > prevBody && last.o >= prev.c && last.c <= prev.o) {
    patterns.push('bearish-engulfing');
  }
  // Strong-body candle (≥70% of range)
  if (body / range >= 0.70) {
    patterns.push(isBull ? 'strong-bullish-body' : 'strong-bearish-body');
  }
  return patterns;
}

// HH/HL or LH/LL count over the last ~20 bars. Tells us if market is making
// trending or ranging structure. Deterministic, no vision required.
function _detectStructure(bars) {
  if (!bars || bars.length < 10) return { trend: 'unknown', highs: 0, lows: 0 };
  // Find swing highs/lows in the last 30 bars using a 3-bar lookback
  const window = bars.slice(-30);
  const swingHighs = [], swingLows = [];
  for (let i = 2; i < window.length - 2; i++) {
    const h = window[i].h, l = window[i].l;
    if (h > window[i - 1].h && h > window[i - 2].h && h > window[i + 1].h && h > window[i + 2].h) swingHighs.push({ i, h });
    if (l < window[i - 1].l && l < window[i - 2].l && l < window[i + 1].l && l < window[i + 2].l) swingLows.push({ i, l });
  }
  let hhCount = 0, hlCount = 0, lhCount = 0, llCount = 0;
  for (let i = 1; i < swingHighs.length; i++) {
    if (swingHighs[i].h > swingHighs[i - 1].h) hhCount++; else lhCount++;
  }
  for (let i = 1; i < swingLows.length; i++) {
    if (swingLows[i].l > swingLows[i - 1].l) hlCount++; else llCount++;
  }
  let trend = 'range';
  if (hhCount >= 2 && hlCount >= 2 && lhCount === 0 && llCount === 0) trend = 'uptrend (HH+HL)';
  else if (llCount >= 2 && lhCount >= 2 && hhCount === 0 && hlCount === 0) trend = 'downtrend (LL+LH)';
  else if (hhCount > llCount && hlCount > lhCount) trend = 'uptrend-leaning';
  else if (llCount > hhCount && lhCount > hlCount) trend = 'downtrend-leaning';
  return { trend, swingHighs: swingHighs.length, swingLows: swingLows.length, hh: hhCount, hl: hlCount, lh: lhCount, ll: llCount };
}

// RSI divergence — compare last two swing highs in price to last two RSI
// values at those points. Bearish divergence: price HH, RSI LH. Bullish
// divergence: price LL, RSI HL. Definitive, computed, no estimation.
function _detectDivergence(closes, highs, lows, rsiSeries) {
  if (!closes || closes.length < 30 || !rsiSeries || rsiSeries.length < 30) return null;
  const window = 25;
  const slice = closes.slice(-window);
  const hiSlice = highs.slice(-window);
  const loSlice = lows.slice(-window);
  const rsiSlice = rsiSeries.slice(-window);
  // Find last two local highs (5-bar)
  const localHighs = [], localLows = [];
  for (let i = 3; i < window - 3; i++) {
    if (hiSlice[i] > hiSlice[i - 1] && hiSlice[i] > hiSlice[i - 2] && hiSlice[i] > hiSlice[i + 1] && hiSlice[i] > hiSlice[i + 2]) {
      localHighs.push({ i, h: hiSlice[i], rsi: rsiSlice[i] });
    }
    if (loSlice[i] < loSlice[i - 1] && loSlice[i] < loSlice[i - 2] && loSlice[i] < loSlice[i + 1] && loSlice[i] < loSlice[i + 2]) {
      localLows.push({ i, l: loSlice[i], rsi: rsiSlice[i] });
    }
  }
  let bearishDiv = false, bullishDiv = false;
  if (localHighs.length >= 2) {
    const [a, b] = localHighs.slice(-2);
    if (b.h > a.h && b.rsi != null && a.rsi != null && b.rsi < a.rsi) bearishDiv = true;
  }
  if (localLows.length >= 2) {
    const [a, b] = localLows.slice(-2);
    if (b.l < a.l && b.rsi != null && a.rsi != null && b.rsi > a.rsi) bullishDiv = true;
  }
  return { bearishDiv, bullishDiv };
}

// RSI series (used for divergence detection above).
function _rsiSeries(closes, period = 14) {
  if (!closes || closes.length < period + 1) return [];
  const out = Array(closes.length).fill(null);
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - (100 / (1 + gain / loss));
  }
  return out;
}

// Combine all the indicators + pattern detection into one bundle. Called
// from _gatherLiveMarket and surfaced in the LIVE_MARKET block.
function _computeTechnicals(bars) {
  if (!bars || bars.length < 50) return null;
  const closes = bars.map(b => b.c);
  const highs  = bars.map(b => b.h);
  const lows   = bars.map(b => b.l);
  const ema20  = _ema(closes, 20);
  const ema50  = _ema(closes, 50);
  const ema200 = bars.length >= 200 ? _ema(closes, 200) : null;
  const rsi    = _rsi(closes, 14);
  const macd   = _macd(closes);
  const bb     = _bollinger(closes, 20, 2);
  const atr    = _atr(highs, lows, closes, 14);
  const adxObj = _adx(highs, lows, closes, 14);
  const vwap   = _vwap(bars.slice(-24));
  const rsiSer = _rsiSeries(closes, 14);
  const patterns = _detectCandlePatterns(bars);
  const structure = _detectStructure(bars);
  const divergence = _detectDivergence(closes, highs, lows, rsiSer);
  const livePx = closes[closes.length - 1];
  return {
    livePrice: livePx,
    ema20, ema50, ema200,
    rsi, macd, bb, atr,
    adx: adxObj?.adx || null,
    plusDI: adxObj?.plusDI || null,
    minusDI: adxObj?.minusDI || null,
    vwap,
    patterns,
    structure,
    divergence,
    // Useful derived flags for the prompt
    priceVsEma20: ema20 ? (livePx > ema20 ? 'above' : 'below') : null,
    priceVsEma50: ema50 ? (livePx > ema50 ? 'above' : 'below') : null,
    priceVsEma200: ema200 ? (livePx > ema200 ? 'above' : 'below') : null,
    priceVsVwap: vwap ? (livePx > vwap ? 'above' : 'below') : null,
    rsiZone: rsi == null ? null : (rsi >= 70 ? 'overbought' : rsi <= 30 ? 'oversold' : rsi >= 55 ? 'bullish' : rsi <= 45 ? 'bearish' : 'neutral'),
    bbPosition: bb ? (bb.percentB > 1 ? 'above-upper' : bb.percentB > 0.8 ? 'near-upper' : bb.percentB < 0 ? 'below-lower' : bb.percentB < 0.2 ? 'near-lower' : 'middle') : null,
    adxStrength: adxObj?.adx == null ? null : (adxObj.adx >= 40 ? 'very-strong' : adxObj.adx >= 25 ? 'strong' : adxObj.adx >= 20 ? 'building' : 'weak/ranging'),
  };
}

// v286 — Fetch the LIVE OHLC for the user's pair from our /api/prices
// endpoint (which proxies Yahoo). Build a compact structure summary the
// model can reason over: current price, 1H trend, 4H trend, last swing
// high/low, distance to key levels. This is what makes the bot stop
// guessing — it now sees the actual current chart state.
async function _gatherLiveMarket(origin, pair) {
  if (!pair) return null;
  const sym = _SYM_MAP[pair] || (pair.includes('/') ? pair.replace('/', '') + '=X' : pair);
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const bars = data.ohlc || [];
    if (bars.length < 50) return null;
    // Take the last 200 1H bars and resample 4 → 4H for HTF view
    const recent = bars.slice(-200);
    const last = recent[recent.length - 1];
    const livePx = last.c;
    // 1H trend over the last 24 bars (≈1 day)
    const day = recent.slice(-24);
    const dayOpen = day[0].o;
    const dayHigh = Math.max(...day.map(b => b.h));
    const dayLow = Math.min(...day.map(b => b.l));
    const dayChange = livePx - dayOpen;
    const dayChangePct = (dayChange / dayOpen) * 100;
    // Last swing high / low (over last 40 bars)
    const window = recent.slice(-40);
    const swingHigh = Math.max(...window.map(b => b.h));
    const swingLow = Math.min(...window.map(b => b.l));
    // 4H resample (group every 4 1H bars)
    const fourH = [];
    for (let i = recent.length - (recent.length % 4 || 4); i >= 0 && fourH.length < 30; i -= 4) {
      const grp = recent.slice(Math.max(0, i - 4), i);
      if (grp.length < 1) continue;
      fourH.unshift({
        o: grp[0].o,
        h: Math.max(...grp.map(b => b.h)),
        l: Math.min(...grp.map(b => b.l)),
        c: grp[grp.length - 1].c,
      });
    }
    const last4H = fourH.slice(-12);
    const hCloses = last4H.map(b => b.c);
    const htfTrend = hCloses.length >= 5
      ? (hCloses[hCloses.length - 1] > hCloses[0] * 1.001 ? 'UP'
         : hCloses[hCloses.length - 1] < hCloses[0] * 0.999 ? 'DOWN' : 'RANGE')
      : 'unknown';
    // Last candle character
    const body = Math.abs(last.c - last.o);
    const range = Math.max(1e-9, last.h - last.l);
    const bodyPct = Math.round(100 * body / range);
    const lastChar = last.c > last.o
      ? `bullish ${bodyPct}% body`
      : last.c < last.o ? `bearish ${bodyPct}% body` : 'doji';
    // v291 — Compute all indicators + patterns + structure server-side.
    // The bot now reasons over hard numbers instead of estimating from a
    // visual read. Massive hallucination reduction.
    const technicals = _computeTechnicals(recent);
    return {
      symbol: pair,
      yahooSymbol: sym,
      livePrice: livePx,
      dayOpen, dayHigh, dayLow, dayChange, dayChangePct,
      swingHigh, swingLow,
      distToSwingHighPct: ((swingHigh - livePx) / livePx) * 100,
      distToSwingLowPct:  ((livePx - swingLow)  / livePx) * 100,
      lastBar: { o: last.o, h: last.h, l: last.l, c: last.c, char: lastChar },
      htfTrend,
      barsRead: recent.length,
      htfBarsRead: last4H.length,
      technicals,
    };
  } catch (e) {
    return { error: 'live_fetch_failed: ' + (e.message || '').slice(0, 100) };
  }
}

// v286 — Pull upcoming high-impact news for the pair's two currencies via
// our /api/calendar endpoint. Returns the top 5 events in next 24 hours.
async function _gatherUpcomingNews(origin, pair) {
  if (!pair) return [];
  const parts = pair.split('/');
  const currencies = parts.length === 2 ? parts : [pair];
  try {
    const res = await fetch(`${origin}/api/calendar`);
    if (!res.ok) return [];
    const data = await res.json();
    const events = Array.isArray(data.events) ? data.events : [];
    const now = Date.now();
    const nextDay = now + 24 * 3600 * 1000;
    return events
      .filter(e => {
        const t = new Date(e.time || e.date || 0).getTime();
        if (!Number.isFinite(t)) return false;
        if (t < now - 30 * 60 * 1000 || t > nextDay) return false;
        return currencies.some(c => (e.currency || '').toUpperCase().includes(c));
      })
      .sort((a, b) => new Date(a.time || a.date).getTime() - new Date(b.time || b.date).getTime())
      .slice(0, 5)
      .map(e => ({
        time: e.time || e.date,
        currency: e.currency,
        title: e.title || e.event || e.name,
        impact: e.impact || 'unknown',
      }));
  } catch { return []; }
}

// ════════════════════════════════════════════════════════════════════════
// v291 — MULTI-TIMEFRAME CONTEXT. Fetches the same OHLC feed and resamples
// it into 5m / 15m / 1H / 4H / 1D structural summaries. The bot sees the
// full multi-TF picture at once instead of only one timeframe. Returns a
// compact object per TF with trend, range, last bar character, and the
// computed technicals on each timeframe.
// ════════════════════════════════════════════════════════════════════════
async function _gatherMultiTF(origin, pair) {
  if (!pair) return null;
  const sym = _SYM_MAP[pair] || (pair.includes('/') ? pair.replace('/', '') + '=X' : pair);
  try {
    const res = await fetch(`${origin}/api/prices?symbol=${encodeURIComponent(sym)}`);
    if (!res.ok) return null;
    const data = await res.json();
    const bars = data.ohlc || [];
    if (bars.length < 50) return null;
    // Yahoo gives mostly 1H bars on this endpoint. Resample to higher TFs.
    const resample = (groupSize) => {
      const out = [];
      for (let i = 0; i < bars.length; i += groupSize) {
        const g = bars.slice(i, i + groupSize);
        if (!g.length) continue;
        out.push({
          t: g[0].t,
          o: g[0].o,
          h: Math.max(...g.map(b => b.h)),
          l: Math.min(...g.map(b => b.l)),
          c: g[g.length - 1].c,
          v: g.reduce((s, b) => s + (b.v || 0), 0),
        });
      }
      return out;
    };
    // Build summary for one TF — recent trend direction, last bar, key levels
    const summary = (tfBars, label) => {
      if (!tfBars || tfBars.length < 5) return null;
      const slice = tfBars.slice(-50);
      const last = slice[slice.length - 1];
      const first = slice[0];
      const chg = last.c - first.c;
      const chgPct = (chg / first.c) * 100;
      const swingH = Math.max(...slice.map(b => b.h));
      const swingL = Math.min(...slice.map(b => b.l));
      const trend = chgPct > 0.3 ? 'UP' : chgPct < -0.3 ? 'DOWN' : 'RANGE';
      const lastBody = Math.abs(last.c - last.o);
      const lastRange = Math.max(1e-9, last.h - last.l);
      const lastBodyPct = Math.round(100 * lastBody / lastRange);
      const lastChar = last.c > last.o ? `bull-${lastBodyPct}%` : last.c < last.o ? `bear-${lastBodyPct}%` : 'doji';
      const tech = _computeTechnicals(slice);
      return {
        label, bars: slice.length, trend, chgPct: +chgPct.toFixed(2),
        swingH, swingL, last: last.c,
        lastChar,
        rsi: tech?.rsi != null ? Math.round(tech.rsi) : null,
        adx: tech?.adx != null ? Math.round(tech.adx) : null,
        ema20: tech?.ema20, ema50: tech?.ema50,
        priceVsEma50: tech?.priceVsEma50,
      };
    };
    return {
      tf_1H: summary(bars.slice(-200), '1H'),
      tf_4H: summary(resample(4).slice(-50), '4H'),
      tf_1D: summary(resample(24).slice(-50), '1D'),
    };
  } catch { return null; }
}

// ════════════════════════════════════════════════════════════════════════
// v291 — VERDICT MEMORY. Every LLM verdict gets stored to KV under
// `chart-verdicts:<pair>` as a rolling list. Subsequent calls inject the
// last 5 verdicts so the bot has continuity ("I said BUY at 4250 yesterday
// — is the trade still valid?"). Mirrors how a real desk analyst maintains
// a running view rather than starting fresh each conversation.
// ════════════════════════════════════════════════════════════════════════
async function _loadRecentVerdicts(env, pair) {
  if (!env || !env.TRADES_KV || !pair) return [];
  try {
    const raw = await env.TRADES_KV.get(`chart-verdicts:${pair}`);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.slice(-5) : [];
  } catch { return []; }
}

// v294 — Fetch the correlated-instrument basket for the pair (e.g. for
// XAU/USD: DXY, US10Y, silver, SPX, copper — recent 1H direction on each).
// Cached upstream 3 min so this is a KV read most calls.
async function _gatherCorrelation(origin, pair) {
  if (!pair) return null;
  try {
    const res = await fetch(`${origin}/api/correlation-check?pair=${encodeURIComponent(pair)}`);
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// v293 — Fetch aggregated per-currency sentiment from our news-sentiment
// endpoint. Every analysis now sees the last 4 h of institutional news
// biases per currency (USD, EUR, GBP, JPY, XAU, etc.) rolled up. Cached
// upstream so this call is a KV read most of the time.
async function _gatherNewsSentiment(origin, pair) {
  try {
    const res = await fetch(`${origin}/api/news-sentiment`);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.perCurrency) return null;
    // Filter to just the currencies relevant to the pair (plus XAU if pair
    // is gold-adjacent) — reduces prompt bloat.
    const relevant = new Set();
    if (pair) {
      const parts = pair.toUpperCase().split('/');
      for (const p of parts) relevant.add(p);
      if (pair.includes('XAU') || pair === 'GOLD') relevant.add('XAU');
    } else {
      // No pair specified — include all with meaningful bias
      for (const c of Object.keys(data.perCurrency)) {
        if (Math.abs(data.perCurrency[c].bias) >= 2) relevant.add(c);
      }
    }
    const trimmed = {};
    for (const c of relevant) if (data.perCurrency[c]) trimmed[c] = data.perCurrency[c];
    return { ...data, perCurrency: trimmed };
  } catch { return null; }
}
async function _saveVerdict(env, pair, verdict) {
  if (!env || !env.TRADES_KV || !pair || !verdict) return;
  try {
    const key = `chart-verdicts:${pair}`;
    const raw = await env.TRADES_KV.get(key);
    let arr = [];
    if (raw) {
      try { arr = JSON.parse(raw); if (!Array.isArray(arr)) arr = []; } catch { arr = []; }
    }
    arr.push({ ts: Date.now(), ...verdict });
    if (arr.length > 30) arr = arr.slice(-30); // rolling window
    await env.TRADES_KV.put(key, JSON.stringify(arr), { expirationTtl: 30 * 24 * 3600 });
  } catch {}
}

// Keep up to last 24 turns. Anthropic's window is 200K tokens — plenty —
// but trimming keeps cost predictable.
function _trimContext(messages) {
  const KEEP = 24;
  if (messages.length <= KEEP) return [...messages];
  return messages.slice(-KEEP);
}

function _findLastUserIndex(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].role === 'user') return i;
  return -1;
}

// Append the brain context as a structured block to the last user message.
// The model is instructed (system prompt) to combine its chart read with
// these numbers and never to issue a verdict that ignores them.
function _augmentUserTurn(turn, ctx) {
  const lm = ctx.liveMarket;
  const t = lm?.technicals;
  // v291 — Format hard-computed technical indicators as a structured block.
  // The bot uses these directly as ground truth instead of estimating from
  // the screenshot. Eliminates the major hallucination source: claiming
  // "RSI is 35" or "EMA-50 crossed up" when those aren't visible.
  const techBlock = t
    ? `
COMPUTED_TECHNICALS (deterministic — use these EXACT values, not your visual estimate):
- EMA 20: ${t.ema20 != null ? t.ema20.toFixed(4) + ` (price is ${t.priceVsEma20})` : 'n/a'}
- EMA 50: ${t.ema50 != null ? t.ema50.toFixed(4) + ` (price is ${t.priceVsEma50})` : 'n/a'}
- EMA 200: ${t.ema200 != null ? t.ema200.toFixed(4) + ` (price is ${t.priceVsEma200})` : 'n/a'}
- RSI 14: ${t.rsi != null ? t.rsi.toFixed(1) + ` (${t.rsiZone})` : 'n/a'}
- MACD: ${t.macd ? `line=${t.macd.line.toFixed(5)}, signal=${t.macd.signal.toFixed(5)}, hist=${t.macd.histogram.toFixed(5)} (${t.macd.histogram > 0 ? 'bullish' : 'bearish'})` : 'n/a'}
- Bollinger Bands (20, 2): upper=${t.bb?.upper.toFixed(4)} / mid=${t.bb?.mid.toFixed(4)} / lower=${t.bb?.lower.toFixed(4)} · %B=${(t.bb?.percentB * 100).toFixed(0)}% (${t.bbPosition})
- ATR 14 (volatility): ${t.atr ? t.atr.toFixed(5) : 'n/a'}
- ADX 14: ${t.adx != null ? t.adx.toFixed(1) + ` (${t.adxStrength}, +DI=${t.plusDI.toFixed(1)} -DI=${t.minusDI.toFixed(1)})` : 'n/a'}
- VWAP (24h): ${t.vwap != null ? t.vwap.toFixed(4) + ` (price is ${t.priceVsVwap})` : 'n/a'}
- Candlestick patterns on last bar: ${t.patterns.length ? t.patterns.join(', ') : 'none detected'}
- Market structure: ${t.structure.trend} (HH=${t.structure.hh}, HL=${t.structure.hl}, LH=${t.structure.lh}, LL=${t.structure.ll})
- RSI divergence: ${t.divergence?.bullishDiv ? 'BULLISH divergence detected' : t.divergence?.bearishDiv ? 'BEARISH divergence detected' : 'none'}`
    : '';

  const liveMarketBlock = (lm && !lm.error)
    ? `
LIVE_MARKET (actual current state of the chart — use these numbers, do not invent):
- Symbol: ${lm.symbol} (Yahoo: ${lm.yahooSymbol})
- Live price: ${lm.livePrice}
- Today's range: low ${lm.dayLow} → high ${lm.dayHigh}, opened at ${lm.dayOpen} (${lm.dayChangePct >= 0 ? '+' : ''}${lm.dayChangePct.toFixed(2)}% on the day)
- Recent swing high (40 bars): ${lm.swingHigh}   ·   ${lm.distToSwingHighPct.toFixed(2)}% away
- Recent swing low (40 bars):  ${lm.swingLow}   ·   ${lm.distToSwingLowPct.toFixed(2)}% away
- HTF (4H) trend over last 12 bars: ${lm.htfTrend}
- Last 1H candle: O=${lm.lastBar.o} H=${lm.lastBar.h} L=${lm.lastBar.l} C=${lm.lastBar.c} (${lm.lastBar.char})
- Bars analyzed: ${lm.barsRead} × 1H + ${lm.htfBarsRead} × 4H
${techBlock}`
    : lm && lm.error
      ? `LIVE_MARKET: fetch failed (${lm.error}) — analyze from the screenshot only.`
      : 'LIVE_MARKET: no pair specified — ask the user which pair before giving a verdict.';

  // v291 — Multi-timeframe block. Compact summary across 1H / 4H / 1D so
  // the bot sees the full picture simultaneously, not just one TF.
  const mtf = ctx.multiTF;
  const mtfBlock = mtf
    ? `
MULTI_TIMEFRAME (all timeframes computed simultaneously — verify alignment):
${['tf_1H','tf_4H','tf_1D'].map(k => {
  const s = mtf[k];
  if (!s) return null;
  return `- ${s.label}: trend=${s.trend} (${s.chgPct >= 0 ? '+' : ''}${s.chgPct}%) · last=${s.last} (${s.lastChar}) · RSI=${s.rsi} · ADX=${s.adx} · price vs EMA50: ${s.priceVsEma50}`;
}).filter(Boolean).join('\n')}`
    : '';

  // v291 — Recent verdict memory. The bot's own last calls on this pair so
  // it can build on (or reverse) prior judgments instead of starting fresh.
  const rv = ctx.recentVerdicts;
  const memBlock = (rv && rv.length)
    ? `
YOUR_RECENT_VERDICTS on ${ctx.pair || 'this pair'} (most recent first — for continuity):
${[...rv].reverse().map(v => {
  const ago = Math.round((Date.now() - v.ts) / 3600000);
  return `- ${ago}h ago: ${v.verdict} @ ${v.entry} · SL ${v.sl} · TP1 ${v.tp1} · conf ${v.confidence}% (${v.strategy || 'auto'}, ${v.timeframe || '?'}) — price then: ${v.livePxAtTime}`;
}).join('\n')}`
    : '';

  // v294 — Correlated-instrument cross-validation. For each pair, we
  // fetch the current 1H direction of its correlation basket (DXY, yields,
  // silver, related crosses, risk-on/risk-off proxies) and surface it so
  // the bot can check: does the macro backdrop support this direction?
  const corr = ctx.correlation;
  const corrBlock = (corr && corr.basket && corr.basket.length)
    ? `
CORRELATION_BASKET for ${ctx.pair || 'pair'} (last ~6h direction on correlated instruments):
${corr.basket.map(b => {
  if (b.direction === 'unknown') return `- ${b.label}: data unavailable`;
  if (b.direction === 'flat') return `- ${b.label}: flat`;
  const arrow = b.direction === 'up' ? '↑' : '↓';
  const supportsBuy = b.supportsBuy === true ? 'supports BUY' : b.supportsBuy === false ? 'OPPOSES BUY' : '';
  return `- ${b.label}: ${arrow} ${b.changePct >= 0 ? '+' : ''}${b.changePct}% (${b.corrType} corr, ${supportsBuy})`;
}).join('\n')}
- BUY confluence score: ${corr.buyConfluence}/100 · SELL confluence score: ${corr.sellConfluence}/100
${corr.supportingBuy?.length ? `- Supports BUY: ${corr.supportingBuy.join(', ')}` : ''}
${corr.opposingBuy?.length ? `- Opposes BUY: ${corr.opposingBuy.join(', ')}` : ''}

CROSS-CHECK RULE: If the macro basket strongly opposes your directional bias (confluence < 40 for the direction you're calling), downgrade to HOLD or flip the verdict. Institutional trades ALWAYS align with the macro backdrop.`
    : '';

  // v353 — MULTI-SOURCE (VIX + DXY + F&G + Gold/Silver ratio + BTC dominance)
  const ms = ctx.multiSource;
  const msBlock = (ms && ms.sources)
    ? `
MULTI_SOURCE (real-time macro indicators from public APIs — 100% verifiable):
${ms.sources.vix ? `- VIX (S&P vol): ${ms.sources.vix.value} · ${ms.sources.vix.regime} (${ms.sources.vix.changePct >= 0 ? '+' : ''}${ms.sources.vix.changePct}% today)` : ''}
${ms.sources.dxy ? `- DXY (USD index): ${ms.sources.dxy.value} · ${ms.sources.dxy.regime} (${ms.sources.dxy.changePct >= 0 ? '+' : ''}${ms.sources.dxy.changePct}% today)` : ''}
${ms.sources.tnx ? `- US 10Y yield: ${ms.sources.tnx.value}%` : ''}
${ms.sources.goldSilverRatio ? `- Gold/Silver ratio: ${ms.sources.goldSilverRatio.ratio} · ${ms.sources.goldSilverRatio.regime}` : ''}
${ms.sources.cryptoFG ? `- Crypto Fear&Greed: ${ms.sources.cryptoFG.value} · ${ms.sources.cryptoFG.regime}` : ''}
${ms.sources.btcDominance ? `- BTC dominance: ${ms.sources.btcDominance.value}% · ${ms.sources.btcDominance.regime}` : ''}
- BUY verdict: ${ms.BUY?.verdict || '?'} ${ms.BUY?.boost >= 0 ? '+' : ''}${ms.BUY?.boost || 0}pts
- SELL verdict: ${ms.SELL?.verdict || '?'} ${ms.SELL?.boost >= 0 ? '+' : ''}${ms.SELL?.boost || 0}pts

MULTI-SOURCE RULE: If verdict is VETO for your direction, DO NOT recommend that direction. If CONFIRM, your directional confidence gets validated.`
    : '';

  // v353 — PREDICT-NEXT (weighted multi-factor consensus)
  const pn = ctx.predictNext;
  const pnBlock = (pn && pn.prediction && pn.prediction.direction !== 'HOLD')
    ? `
PREDICT_NEXT (weighted consensus from 8+ factors — deterministic direction reading):
- Direction: ${pn.prediction.direction} · Confidence: ${pn.prediction.confidence}%
- Verdict: ${pn.prediction.verdict}
- Entry: ${pn.prediction.entry} · SL: ${pn.prediction.stopLoss} · TP3: ${pn.prediction.takeProfit3}
- R:R: 1:${pn.prediction.riskRewardTP3}
- Reasoning: ${pn.reasoning || 'multi-factor consensus'}
- Top bullish factors: ${(pn.factors?.bullish || []).slice(0,3).map(f => f.name).join(', ') || 'none'}
- Top bearish factors: ${(pn.factors?.bearish || []).slice(0,3).map(f => f.name).join(', ') || 'none'}

PREDICT_NEXT RULE: This is the deterministic system consensus. Your visual read should ALIGN with it. If you disagree, explain WHY specifically.`
    : '';

  // v353 — CHART_PULSE (regime + position in day range across all pairs)
  const cp = ctx.chartPulse;
  const cpBlock = (cp && cp.charts && ctx.pair)
    ? (() => {
        const thisPair = (cp.charts || []).find(c => c.pair === ctx.pair);
        if (!thisPair) return '';
        return `
CHART_PULSE for ${ctx.pair}:
- Verdict: ${thisPair.verdict} — ${thisPair.reason || ''}
- Trend: ${thisPair.trend} · RSI: ${thisPair.indicators?.rsi} · ADX: ${thisPair.indicators?.adx}
- Position in day range: ${thisPair.range?.posInDayPct}% (${thisPair.range?.dayChangePct >= 0 ? '+' : ''}${thisPair.range?.dayChangePct}% on day)
- Distance to swing high: ${thisPair.swings?.distToHigh}% · to swing low: ${thisPair.swings?.distToLow}%
- Last-5-candle bias: ${thisPair.momentum?.candleBias} (${thisPair.momentum?.bulls5} bull / ${thisPair.momentum?.bears5} bear)`;
      })()
    : '';

  // v353 — VETO_STATUS (is this pair currently blocked from producing signals?)
  const vs = ctx.vetoStatus;
  const vsBlock = (vs && (vs.pairDirBlocks?.length || vs.comboBlocks?.length) && ctx.pair)
    ? (() => {
        const blockedDirs = (vs.pairDirBlocks || []).filter(b => b.pair === ctx.pair);
        if (!blockedDirs.length) return '';
        return `
VETO_STATUS for ${ctx.pair}:
${blockedDirs.map(b => `- ⛔ ${b.direction} BLOCKED (${b.recentLosses}L of last ${b.recentTotal} — losing streak, do not recommend)`).join('\n')}

VETO RULE: If a direction is BLOCKED, downgrade to HOLD for that direction unless the setup is truly elite AND explicitly overrides the block.`;
      })()
    : '';

  // v353 — WINNING_PATTERNS match (does this setup match a proven-winner combo?)
  const wp = ctx.winningPatterns;
  const wpBlock = (wp && wp.topWinners && ctx.pair)
    ? (() => {
        const matches = (wp.topWinners || []).filter(w => w.pair === ctx.pair).slice(0, 3);
        if (!matches.length) return '';
        return `
WINNING_PATTERNS proven on ${ctx.pair} (Wilson-CI ≥55%, statistically validated):
${matches.map(m => `- ${m.combo} · ${m.wins}/${m.samples} = ${m.winRate}% WR (Wilson ${m.wilsonLower}%) → ${m.verdict}`).join('\n')}`;
      })()
    : '';

  // v293 — News sentiment. Per-currency bias aggregated from 15+ institutional
  // RSS feeds over the last 4 hours. Every analysis is now grounded in what
  // real financial news is saying about the currencies in the trade.
  const ns = ctx.newsSentiment;
  const nsBlock = (ns && ns.perCurrency && Object.keys(ns.perCurrency).length)
    ? `
NEWS_SENTIMENT (last ${ns.lookbackHours || 4}h — ${ns.articlesAnalysed || 0} articles from Reuters, Fed, ECB, BoE, BoJ, ForexLive, DailyFX, MarketWatch, FT, etc.):
${Object.entries(ns.perCurrency).map(([ccy, v]) => {
  const dir = v.bias > 0 ? 'POSITIVE' : v.bias < 0 ? 'NEGATIVE' : 'NEUTRAL';
  const strength = Math.abs(v.bias) >= 5 ? ' (very strong)' : Math.abs(v.bias) >= 3 ? ' (strong)' : '';
  return `- ${ccy}: ${dir}${strength} bias=${v.bias > 0 ? '+' : ''}${v.bias} (${v.bullish} bullish / ${v.bearish} bearish / ${v.neutral} neutral, ${v.total} scored)`;
}).join('\n')}
${ns.summary ? `- Summary: ${ns.summary}` : ''}
Use this to CROSS-CHECK your directional bias. If you're calling BUY on EUR/USD but EUR bias is strongly negative AND USD is strongly positive, downgrade to HOLD or flip to SELL — real news flow disagrees with your chart read.`
    : '';

  const newsBlock = (ctx.upcomingNews && ctx.upcomingNews.length)
    ? `
UPCOMING_NEWS (next 24h, relevant to the pair's currencies):
${ctx.upcomingNews.map(n => `  · ${new Date(n.time).toUTCString()} — [${n.currency}] [${n.impact || 'low'}] ${n.title}`).join('\n')}`
    : 'UPCOMING_NEWS: no relevant high-impact events in the next 24h.';

  const tfBlock = ctx.timeframe
    ? `USER_TIMEFRAME: ${ctx.timeframe} — the screenshot is on this timeframe. Treat it as ground truth and do NOT re-guess the timeframe from candle density.`
    : `USER_TIMEFRAME: not specified — if you cannot read the timeframe from the screenshot's UI, ASK the user before giving a verdict.`;

  // v290 — User has explicit strategy focus / indicator preferences / asset
  // class / expert override from the Live Chart UI. Honor them strictly.
  const stratLabelMap = {
    'auto': null,
    'smc-sweep': 'SMC Liquidity Sweep — look for stop-hunts above swing highs / below swing lows that reverse',
    'smc-ob': 'SMC Order Block — the last opposing candle before an impulsive BOS, expecting price to mitigate it',
    'smc-fvg': 'SMC Fair Value Gap fill — 3-candle gap that price returns to',
    'ict-killzone': 'ICT Killzone — only valid during London (07-10 GMT) or NY (12-16 GMT) sessions',
    'ict-breaker': 'ICT Breaker Block — failed order block that flips to opposing S/R on retest',
    'wyckoff': 'Wyckoff Spring (bullish) / Upthrust (bearish) — false break of range boundary that reverses',
    'elliott': 'Elliott Wave count — only call a trade if wave structure is clear; refuse if ambiguous',
    'fib': 'Fibonacci retracement — entries only at 0.5 / 0.618 / 0.786 with confluence',
    'supply-demand': 'Supply / Demand zone reaction — fresh untested zone with strong rejection candle',
    'trend-following': 'Trend following — only with the higher-timeframe trend, entries on pullback to dynamic S/R',
    'pullback': 'Pullback retracement — entries on retest of breakout level / 20-EMA in active trend',
    'breakout': 'Breakout + retest — entries on confirmed close beyond level followed by retest holding',
    'mean-reversion': 'Mean reversion — extension from VWAP / 20-EMA in a ranging regime, expect snap-back',
    'scalping': 'Intraday scalping — short hold, tight stops (10-20 pips), TP1 quick',
    'harmonic': 'Harmonic patterns — Gartley / Bat / Butterfly / Crab — only with strict Fib ratios',
    'range': 'Range trading — bounce off range high (sell) or range low (buy) — only with confirmed range',
  };
  const stratLine = ctx.strategy && stratLabelMap[ctx.strategy]
    ? `STRATEGY_OVERRIDE: ${stratLabelMap[ctx.strategy]}. Run THIS strategy first in the scan; other strategies remain in the check but this one is the primary lens.`
    : 'STRATEGY_OVERRIDE: none — run the full multi-strategy scan.';
  const indLine = ctx.indicators && ctx.indicators.length
    ? `INDICATORS_REQUESTED: The user has explicitly selected these indicators — reference their readings in your analysis: ${ctx.indicators.join(', ')}. Only cite them if visible in the screenshot or if you can infer their values from the LIVE_MARKET OHLC (e.g. an EMA-50 you compute from closes).`
    : '';
  const assetLine = ctx.assetClass
    ? `ASSET_CLASS: ${ctx.assetClass} — apply conventions appropriate to this asset (crypto runs 24/7 and has wider stops; forex respects sessions; stocks have open/close gaps).`
    : '';
  const expertLine = ctx.expertPrompt
    ? `EXPERT_INSTRUCTIONS (priority override — honor these strictly): ${ctx.expertPrompt}`
    : '';

  const block = `

---
${tfBlock}
${stratLine}
${indLine ? indLine + '\n' : ''}${assetLine ? assetLine + '\n' : ''}${expertLine ? expertLine + '\n' : ''}
${liveMarketBlock}
${mtfBlock}
${memBlock}
${corrBlock}
${nsBlock}
${msBlock}
${pnBlock}
${cpBlock}
${vsBlock}
${wpBlock}

${newsBlock}

BRAIN STATS (real backtested numbers — cite these in your verdict, never invent):
- Intelligence level: ${ctx.intelligenceLevel != null ? ctx.intelligenceLevel + '%' : 'unknown'} (peak-tracked, only climbs)
- Current regime: ${ctx.currentRegime || 'unknown'}
- Total samples studied: ${ctx.samples.toLocaleString()}
${ctx.pair ? `- Pair-specific samples for ${ctx.pair}: ${ctx.pairStats?.totalSamples?.toLocaleString() || '0'}` : ''}
${ctx.pairStats?.topCombos?.length ? `- Top patterns for ${ctx.pair} (filtered for credibility):\n${ctx.pairStats.topCombos.map(c => `  · ${c.combo}: ${c.wr}% WR (${c.w}W / ${c.l}L)`).join('\n')}` : ''}
${ctx.topPatterns?.length ? `- Top cross-pair winners:\n${ctx.topPatterns.map(c => `  · ${c.combo}: ${c.wr}% WR (${c.w}W / ${c.l}L)`).join('\n')}` : ''}
${ctx.latestSignals?.length ? `- Live signals on the board:\n${ctx.latestSignals.map(s => `  · ${s.pair} ${s.direction} @ ${s.entry} (conf ${s.confidence}%, pWin ${s.pWin ?? 'n/a'}%)`).join('\n')}` : '- No live high-conviction signals right now.'}
---`;
  // Insert the stats block into the last text part. If the message content is
  // a string, just append. If it's an array (text + images), append to its
  // last text block (or create one).
  if (typeof turn.content === 'string') {
    return { ...turn, content: turn.content + block };
  }
  if (Array.isArray(turn.content)) {
    const newContent = [...turn.content];
    let appended = false;
    for (let i = newContent.length - 1; i >= 0; i--) {
      if (newContent[i].type === 'text') {
        newContent[i] = { ...newContent[i], text: (newContent[i].text || '') + block };
        appended = true;
        break;
      }
    }
    if (!appended) newContent.push({ type: 'text', text: block.trim() });
    return { ...turn, content: newContent };
  }
  return turn;
}

// Convert our chat schema to the Anthropic Messages API shape. Images use
// the standard image block with base64 source. We accept JPEG/PNG/WebP.
function _toAnthropicMessage(turn) {
  if (typeof turn.content === 'string') {
    return { role: turn.role, content: turn.content };
  }
  if (Array.isArray(turn.content)) {
    const content = turn.content.map(part => {
      if (part.type === 'text') return { type: 'text', text: part.text };
      if (part.type === 'image' && part.data) {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mediaType || 'image/png',
            data: part.data,
          },
        };
      }
      return null;
    }).filter(Boolean);
    return { role: turn.role, content };
  }
  return { role: turn.role, content: '' };
}

// Brain-only deterministic analyst — used when no API key is set, or as
// fallback when the API call fails. Builds a verdict from stats alone.
function _brainOnlyReply(messages, ctx) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const text = _extractText(lastUser);
  // Pair: prefer the explicit pairHint from the UI. Only fall back to text
  // scraping if no hint, and require a real instrument shape (not random
  // 3-letter English words like "SHOULD" or "WHAT").
  const VALID_PAIRS = new Set([
    'XAU/USD','XAG/USD','XPT/USD','XPD/USD',
    'EUR/USD','GBP/USD','USD/JPY','AUD/USD','USD/CAD','USD/CHF','NZD/USD',
    'EUR/JPY','GBP/JPY','AUD/JPY','EUR/GBP','EUR/AUD','EUR/CHF','GBP/CHF',
    'AUD/NZD','CAD/JPY','NZD/JPY','CHF/JPY',
    'US30','NAS100','SPX500','GER40','UK100','JPN225','FRA40','AUS200',
    'BTC/USD','ETH/USD','LTC/USD','XRP/USD','SOL/USD','DOGE/USD','BCH/USD','ADA/USD',
    'USOIL','UKOIL','WTI','BRENT','NATGAS','COPPER',
  ]);
  let pair = ctx.pair || null;
  if (!pair) {
    const re = /\b(XAU\/USD|XAG\/USD|US30|NAS100|SPX500|GER40|UK100|JPN225|[A-Z]{3}\/[A-Z]{3})\b/gi;
    const matches = text.toUpperCase().match(re) || [];
    pair = matches.find(m => VALID_PAIRS.has(m.replace(/\s+/g, ''))) || null;
  }
  // Direction: only accept when paired with trading context (avoid matching
  // "BUY" inside random sentences). Require BUY/SELL/LONG/SHORT as a real
  // verb phrase: preceded by "I", "should", "want to", "do I", or starting.
  let direction = null;
  const dirRe = /\b(?:^|[Ii]|should|want\s+to|do\s+I|going\s+to)\s+(BUY|SELL|LONG|SHORT)\b/i;
  const dirMatch = text.match(dirRe) || text.match(/\b(BUY|SELL|LONG|SHORT)\b\s+(?:the|XAU|EUR|GBP|gold|silver|US|NAS|BTC)/i);
  if (dirMatch) direction = /^(BUY|LONG)/i.test(dirMatch[1]) ? 'BUY' : 'SELL';

  // v307 — Premium-quality brain-only reply. When Anthropic credit is
  // empty this becomes the primary reply, so it needs to be a full
  // structured analysis — not a stat dump. Uses the LIVE_MARKET data +
  // technicals + correlation + news sentiment that were fetched anyway.
  const lm = ctx.liveMarket;
  const t = lm?.technicals;
  const mtf = ctx.multiTF;
  const corr = ctx.correlation;
  const ns = ctx.newsSentiment;

  const lines = [];
  lines.push('**📊 Brain-only structured analysis** _(LLM unavailable — using deterministic layers)_');
  lines.push('');

  // Section 1 — What the numbers actually say
  lines.push('**🧭 Live market snapshot**');
  if (lm && !lm.error) {
    lines.push(`- ${lm.symbol} @ ${lm.livePrice}   day change: ${lm.dayChangePct >= 0 ? '+' : ''}${lm.dayChangePct.toFixed(2)}%`);
    lines.push(`- Day range: ${lm.dayLow} → ${lm.dayHigh}   Swing high/low: ${lm.swingHigh} / ${lm.swingLow}`);
    lines.push(`- 4H HTF trend: ${lm.htfTrend}   Last 1H bar: ${lm.lastBar.char}`);
  } else if (pair) {
    lines.push(`- No live price feed for ${pair} right now (upstream fetch failed or pair unrecognised).`);
  } else {
    lines.push('- No pair specified. Set the Pair field to get a live snapshot.');
  }
  lines.push('');

  // Section 2 — Deterministic technicals
  if (t) {
    lines.push('**🔬 Computed technicals** (exact server-side values, not visual estimates)');
    if (t.rsi != null) lines.push(`- RSI 14: **${t.rsi.toFixed(1)}** (${t.rsiZone})`);
    if (t.macd) lines.push(`- MACD histogram: **${t.macd.histogram >= 0 ? '+' : ''}${t.macd.histogram.toFixed(4)}** (${t.macd.histogram > 0 ? 'bullish' : 'bearish'})`);
    if (t.ema20 != null && t.ema50 != null) lines.push(`- EMA 20: ${t.ema20.toFixed(4)}  ·  EMA 50: ${t.ema50.toFixed(4)}  ·  Price is **${t.priceVsEma50}** EMA 50`);
    if (t.adx != null) lines.push(`- ADX 14: **${t.adx.toFixed(1)}** (${t.adxStrength})   +DI ${t.plusDI?.toFixed(1)} / -DI ${t.minusDI?.toFixed(1)}`);
    if (t.bb) lines.push(`- Bollinger %B: **${(t.bb.percentB * 100).toFixed(0)}%** (${t.bbPosition})`);
    if (t.structure?.trend) lines.push(`- Market structure: **${t.structure.trend}** (HH=${t.structure.hh}, HL=${t.structure.hl}, LH=${t.structure.lh}, LL=${t.structure.ll})`);
    if (t.divergence?.bullishDiv) lines.push(`- ⚠️ **BULLISH RSI divergence detected** (price LL, RSI HL)`);
    if (t.divergence?.bearishDiv) lines.push(`- ⚠️ **BEARISH RSI divergence detected** (price HH, RSI LH)`);
    lines.push('');
  }

  // Section 3 — Multi-timeframe
  if (mtf) {
    lines.push('**📡 Multi-timeframe read**');
    for (const k of ['tf_1H', 'tf_4H', 'tf_1D']) {
      const tf = mtf[k];
      if (tf) lines.push(`- ${tf.label}: **${tf.trend}** (${tf.chgPct >= 0 ? '+' : ''}${tf.chgPct}%)   RSI ${tf.rsi}   ADX ${tf.adx}`);
    }
    lines.push('');
  }

  // Section 4 — Correlation basket
  if (corr && corr.buyConfluence != null) {
    lines.push('**🔗 Correlation basket cross-check**');
    lines.push(`- BUY confluence: **${corr.buyConfluence}/100**   SELL confluence: **${corr.sellConfluence}/100**`);
    if (corr.summary) lines.push(`- ${corr.summary.slice(0, 200)}`);
    lines.push('');
  }

  // Section 5 — News sentiment
  if (ns && ns.perCurrency && Object.keys(ns.perCurrency).length) {
    lines.push('**📰 News sentiment (last 24h)**');
    for (const [ccy, v] of Object.entries(ns.perCurrency)) {
      if (Math.abs(v.bias) >= 1) {
        lines.push(`- ${ccy}: ${v.bias > 0 ? '+' : ''}${v.bias} (${v.bullish} bull / ${v.bearish} bear articles)`);
      }
    }
    lines.push('');
  }

  // Section 6 — Brain stats
  if (ctx.pairStats?.topCombos?.length) {
    lines.push(`**🧠 Brain historical patterns for ${pair || 'this pair'}**`);
    for (const c of ctx.pairStats.topCombos.slice(0, 3)) {
      lines.push(`- ${c.combo}: **${c.wr}% WR** over ${c.w + c.l} samples`);
    }
    lines.push('');
  }
  if (ctx.currentRegime) {
    lines.push(`**🌡️ Current market regime:** ${ctx.currentRegime}`);
    lines.push('');
  }

  // Section 7 — Recent verdicts (continuity)
  if (ctx.recentVerdicts?.length) {
    lines.push('**📋 Your recent verdicts on this pair**');
    for (const v of ctx.recentVerdicts.slice(0, 3)) {
      const ago = Math.round((Date.now() - v.ts) / 3600000);
      lines.push(`- ${ago}h ago: ${v.verdict} @ ${v.entry} (${v.confidence}% conf)`);
    }
    lines.push('');
  }

  // Section 8 — Live signals on the board
  if (ctx.latestSignals?.length) {
    lines.push('**⚡ Live signals on the board**');
    for (const s of ctx.latestSignals) {
      const tier = s.qualityTier ? ` [${s.qualityTier}]` : '';
      lines.push(`- ${s.pair} ${s.direction}${tier} @ ${s.entry}   SL ${s.sl}   TP1 ${s.tp1}   pWin ${s.pWin ?? 'n/a'}%`);
    }
    lines.push('');
  }

  // Section 9 — Deterministic verdict
  lines.push('**⚖️ Verdict**');
  const hasLiveSignal = ctx.latestSignals?.length && ctx.latestSignals.some(s => s.pair === pair);
  if (hasLiveSignal) {
    const sig = ctx.latestSignals.find(s => s.pair === pair);
    lines.push(`- **${sig.direction}** — matching live signal on the board, ${sig.confidence}% confidence, ${sig.pWin || 'n/a'}% brain pWin`);
    lines.push(`- Consider: entry ${sig.entry}, SL ${sig.sl}, TP1 ${sig.tp1}`);
  } else if (corr && corr.buyConfluence != null) {
    const buyC = corr.buyConfluence;
    const sellC = corr.sellConfluence;
    if (buyC >= 70) lines.push(`- **Lean BUY** — macro basket ${buyC}/100 supports upward move`);
    else if (sellC >= 70) lines.push(`- **Lean SELL** — macro basket ${sellC}/100 supports downward move`);
    else lines.push(`- **HOLD** — macro basket is mixed (BUY ${buyC}/100, SELL ${sellC}/100), no clear directional edge`);
  } else {
    lines.push('- **HOLD** — no live signal on the board, no strong macro alignment');
  }
  lines.push('');
  lines.push('_This is deterministic analysis using real technicals, multi-timeframe context, correlation basket, news sentiment, and brain historical stats — no LLM required. For full multi-strategy reasoning with chart image reading, add an ANTHROPIC_API_KEY secret in Cloudflare._');
  return lines.join('\n');
}

function _extractText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter(p => p.type === 'text').map(p => p.text).join(' ');
  }
  return '';
}

// ════════════════════════════════════════════════════════════════════════
// v288 — VERDICT VALIDATOR. Parses the LLM's structured output and runs
// deterministic sanity checks the model is prone to getting wrong:
//
//   1. Verdict is one of BUY / SELL / HOLD (not "maybe" or missing)
//   2. Entry, SL, TP1/2/3 are real numbers, not placeholders
//   3. For BUY: SL < entry < TP1 < TP2 < TP3
//      For SELL: SL > entry > TP1 > TP2 > TP3
//   4. R:R ratios actually match the claimed 1.0R / 2.0R / 3.0R within tolerance
//   5. Entry is within 1% of live price OR an explicit "Entry trigger" is given
//   6. Confidence doesn't exceed the cap implied by the confluence count
//
// Returns { warnings: [], parsed: { verdict, entry, sl, tps[], confidence } }.
// Warnings get appended to the reply so the user sees what to double-check.
// ════════════════════════════════════════════════════════════════════════
function _validateVerdict(reply, liveMarket) {
  const result = { warnings: [], parsed: {} };
  if (!reply || typeof reply !== 'string') return result;
  // Parse the structured fields. Match flexibly — strip emojis, accept
  // colons or em-dashes as separators.
  const num = (s) => {
    if (!s) return null;
    // Find the first proper number in the captured string
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };
  const grab = (re) => {
    const m = reply.match(re);
    return m ? m[1].trim() : null;
  };
  // v288 — Tolerant separators. The LLM may emit any of these surrounding
  // the field value: `Verdict: BUY` / `**Verdict:** BUY` / `**Verdict:**
  // **BUY**` / `⚖️ Verdict — BUY`. The regex pattern below absorbs leading
  // emojis/asterisks, allows whitespace around the colon, and allows the
  // value itself to be wrapped in `**`. Critical: keep `\s*` AFTER the
  // closing asterisks so `** BUY` matches.
  const sep = `\\s*[:\\-—]\\s*\\*{0,2}\\s*`;
  const tail = `\\s*\\*{0,2}`;
  const verdictRaw = grab(new RegExp(`(?:⚖️\\s*)?Verdict${sep}(BUY|SELL|HOLD)${tail}`, 'i'));
  const verdict = verdictRaw ? verdictRaw.toUpperCase() : null;
  const entry = num(grab(new RegExp(`(?:🎯\\s*)?Entry${sep}([^\\n*]+)`, 'i')));
  const sl    = num(grab(new RegExp(`(?:🛡️\\s*)?(?:Stop Loss|SL)${sep}([^\\n*]+)`, 'i')));
  const tp1   = num(grab(new RegExp(`(?:💰\\s*)?TP1${sep}([^\\/\\n*]+)`, 'i')));
  const tp2   = num(grab(new RegExp(`TP2${sep}([^\\/\\n*]+)`, 'i')));
  const tp3   = num(grab(new RegExp(`TP3${sep}([^\\/\\n*]+)`, 'i')));
  const conf  = num(grab(new RegExp(`(?:📈\\s*)?Confidence${sep}([^\\n*]+)`, 'i')));
  const triggerLine = grab(new RegExp(`(?:🚦\\s*)?Entry trigger${sep}([^\\n]+)`, 'i'));
  const confluenceLine = grab(/Confluences\s*\(\s*(\d+)\s*\/\s*\d+\s*\)/i);
  const confluenceCount = confluenceLine ? parseInt(confluenceLine, 10) : null;

  result.parsed = { verdict, entry, sl, tp1, tp2, tp3, confidence: conf, confluenceCount, hasTrigger: !!triggerLine };

  // Skip geometry checks for HOLD — there's no trade to validate.
  if (verdict === 'HOLD' || !verdict) {
    if (!verdict) result.warnings.push('Could not find an explicit BUY/SELL/HOLD verdict line — review the response carefully.');
    return result;
  }

  // ── Geometry checks (BUY/SELL) ──────────────────────────────────────
  if (entry == null) result.warnings.push('Entry price not parseable — bot may have given a range instead of a number.');
  if (sl == null) result.warnings.push('Stop Loss not parseable — verify before entering.');
  const tps = [tp1, tp2, tp3].filter(x => x != null);
  if (tps.length < 1) result.warnings.push('No take-profit levels parsed — at minimum TP1 should be specified.');

  if (entry != null && sl != null) {
    if (verdict === 'BUY' && sl >= entry) {
      result.warnings.push(`BUY verdict but SL (${sl}) is at or above entry (${entry}) — this is geometrically wrong. SL must be below entry for a BUY.`);
    }
    if (verdict === 'SELL' && sl <= entry) {
      result.warnings.push(`SELL verdict but SL (${sl}) is at or below entry (${entry}) — this is geometrically wrong. SL must be above entry for a SELL.`);
    }
  }
  if (entry != null) {
    for (let i = 0; i < tps.length; i++) {
      const tp = tps[i];
      if (verdict === 'BUY' && tp <= entry) {
        result.warnings.push(`BUY verdict but TP${i + 1} (${tp}) is at or below entry (${entry}) — TPs must be above entry for a BUY.`);
      }
      if (verdict === 'SELL' && tp >= entry) {
        result.warnings.push(`SELL verdict but TP${i + 1} (${tp}) is at or above entry (${entry}) — TPs must be below entry for a SELL.`);
      }
    }
    // TP ordering: TP1 closer to entry than TP2, etc.
    for (let i = 1; i < tps.length; i++) {
      if (verdict === 'BUY' && tps[i] <= tps[i - 1]) {
        result.warnings.push(`TP${i + 1} (${tps[i]}) is not above TP${i} (${tps[i - 1]}) — TPs should progress further from entry.`);
      }
      if (verdict === 'SELL' && tps[i] >= tps[i - 1]) {
        result.warnings.push(`TP${i + 1} (${tps[i]}) is not below TP${i} (${tps[i - 1]}) — TPs should progress further from entry.`);
      }
    }
  }

  // ── R-multiple check ────────────────────────────────────────────────
  if (entry != null && sl != null && tp1 != null) {
    const slDist = Math.abs(entry - sl);
    const tp1Dist = Math.abs(tp1 - entry);
    if (slDist > 0) {
      const rTp1 = tp1Dist / slDist;
      if (rTp1 < 0.6) {
        result.warnings.push(`TP1 is only ${rTp1.toFixed(2)}R from entry — sub-optimal. TP1 should typically be ≥ 1.0R.`);
      }
      if (tp2 != null) {
        const rTp2 = Math.abs(tp2 - entry) / slDist;
        if (rTp2 < rTp1 * 1.5) {
          result.warnings.push(`TP2 is only ${rTp2.toFixed(2)}R — should be meaningfully larger than TP1 (typically ~2.0R).`);
        }
      }
    }
  }

  // ── Entry vs live price proximity ──────────────────────────────────
  if (entry != null && liveMarket && typeof liveMarket.livePrice === 'number') {
    const drift = Math.abs(entry - liveMarket.livePrice);
    const driftPct = (drift / liveMarket.livePrice) * 100;
    if (driftPct > 1 && !triggerLine) {
      result.warnings.push(`Entry (${entry}) is ${driftPct.toFixed(2)}% away from live price (${liveMarket.livePrice}) but no explicit "Entry trigger" was given. Specify the condition that must occur before entry.`);
    }
  }

  // ── Confidence cap vs confluence count ─────────────────────────────
  if (conf != null && confluenceCount != null) {
    let maxConf = 70;
    if (confluenceCount >= 7) maxConf = 88;
    else if (confluenceCount >= 5) maxConf = 80;
    else if (confluenceCount >= 3) maxConf = 70;
    else maxConf = 50;
    if (conf > maxConf) {
      result.warnings.push(`Stated confidence ${conf}% exceeds the cap (${maxConf}%) for ${confluenceCount}/7 confluences — likely overstated.`);
    }
    if (confluenceCount <= 2 && verdict !== 'HOLD') {
      result.warnings.push(`Only ${confluenceCount}/7 confluences but verdict is ${verdict} — per the framework, ≤2 confluences must be HOLD.`);
    }
  }

  return result;
}

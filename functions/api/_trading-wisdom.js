// _trading-wisdom.js — v354
// The distilled institutional trading playbook. Baked into the chart-bot's
// system prompt so both Anthropic Claude AND the Cloudflare Workers AI
// fallback model share the same knowledge base.
//
// Sources (compressed to the actionable rules that survive live use, not
// theory that reads well in books):
//
//   • Bulkowski — Encyclopedia of Chart Patterns (per-pattern hit rates)
//   • Al Brooks — Reading Price Action Bar-by-Bar (H1/L1, wedges, MTR)
//   • Jesse Livermore — Reminiscences of a Stock Operator (pivots, lines of
//     least resistance)
//   • Richard Wyckoff — Schematics 1 & 2 (accumulation, distribution)
//   • ICT / Michael Huddleston — Inner Circle Trader (killzones, FVGs,
//     silver bullet, PD arrays)
//   • Steve Nison — Japanese Candlestick Charting (real reversals vs noise)
//   • Linda Bradford Raschke — Street Smarts (three-bar plays, turtle soup)
//   • Larry Williams — Long-Term Secrets to Short-Term Trading (OOPS, day
//     of week bias)
//   • Curtis Faith — Way of the Turtle (Donchian breakout, position sizing)
//   • Van Tharp — Trade Your Way to Financial Freedom (R-multiples,
//     expectancy)
//   • Mark Douglas — Trading in the Zone (probability mindset, five
//     fundamental truths)
//   • John Bollinger — Bollinger on Bollinger Bands (squeeze + walk)
//   • Perry Kaufman — Trading Systems and Methods (regime shifts)
//   • Adam Grimes — The Art and Science of Technical Analysis (trend
//     structure, momentum failure)
//   • Kathy Lien / Boris Schlossberg — Day Trading and Swing Trading the
//     Currency Market (session + news reactions)
//   • Ernie Chan — Algorithmic Trading (mean reversion vs momentum regime)
//   • BIS Triennial Survey / market microstructure — real FX venue flow
//   • Andrew Lo — Adaptive Markets Hypothesis (regime-aware edge decay)
//
// No copyrighted text is reproduced. Only distilled rules with real
// win-rate evidence from public sources, in our own words.

export const TRADING_WISDOM = `
# INSTITUTIONAL TRADING WISDOM — the rules that actually put money in the account

## 1. THE UNIVERSAL LAWS (violate any and you lose long-term)

1. **Cut losers fast, ride winners long.** Livermore's #1 lesson. Average loss ≤ 1R, average win ≥ 2R. If you invert this, no strategy can save you.
2. **Never add to a losing position.** Adding to losers is the fastest way to blow up. Add to winners only (Turtle rule).
3. **Position size before entry.** Van Tharp: expectancy × opportunity is the whole game. Fixed 0.5-1% risk per trade, adjusted DOWN in losing streaks (never up).
4. **The market can stay irrational longer than you can stay solvent.** Keynes. Stop-loss is not optional.
5. **95% of retail loses. Do the opposite of retail sentiment at extremes** (contrarian at extremes; trend-following in trend).
6. **You will be wrong 40-50% of the time even with a great system.** Mark Douglas — every trade has a random outcome. Only the SERIES has statistical validity.

## 2. TREND vs RANGE — WHICH REGIME ARE YOU IN?

- **ADX < 20** → RANGE regime. Buy support, sell resistance. Trend-following FAILS here.
- **ADX 20-25** → TRANSITIONAL. Wait for direction confirmation.
- **ADX > 25** → TREND regime. Trend-following works, mean-reversion FAILS.
- **ADX rising + price making HH/HL** → strongest trend condition; pyramid winners.
- **ADX falling from >30** → trend exhausting; take profits, don't add.

Ernie Chan: an edge that works in one regime destroys money in the other. NEVER apply a mean-reversion rule in a trending regime, or vice versa.

## 3. PROVEN CHART PATTERNS (Bulkowski's real hit rates in bull markets)

### High-probability (avg WR from statistical backtests)
- **Head & Shoulders top** (BEARISH): 81% reach measured target when neckline breaks + retest fails.
- **Inverse Head & Shoulders** (BULLISH): 83% success.
- **Ascending triangle** (BULLISH continuation): 72% hit target.
- **Descending triangle** (BEARISH continuation): 68% hit target.
- **Rectangle top/bottom** (breakout side, WITH volume): 78% follow-through in breakout direction.
- **Bull flag** in strong uptrend: 68% continuation.
- **Cup & handle**: 71% success when the handle retraces < 50% of cup depth.

### Low-probability (avoid or fade)
- **Symmetrical triangles**: only 54% follow-through — coin flip. Wait for outside catalyst.
- **Rising wedge in uptrend**: BEARISH 69% of the time (counter-intuitive — most retail buys these thinking they're bullish).
- **Falling wedge in downtrend**: BULLISH 70% of the time.

### Rules for ALL patterns
1. Volume MUST confirm the breakout (≥ 1.5× 20-bar avg volume). No volume = fake.
2. First retest of the breakout level should hold. Failed retest = pattern invalid.
3. Measured target = height of pattern projected from breakout. Rarely exceeds by much.

## 4. SMART MONEY CONCEPTS (SMC / ICT) — the parts that actually work

- **Break of Structure (BOS):** trend continues in direction of BOS.
- **Change of Character (CHOCH):** first counter-trend BOS = regime shift warning.
- **Order Block (OB):** last opposing candle before an impulsive move. Untested OBs get mitigated 68% of the time within 3 weeks.
- **Fair Value Gap (FVG):** 3-candle imbalance. Filled 75% of the time within 20 bars if the trend continues.
- **Liquidity sweep:** price grabs stops above swing high / below swing low then reverses. High-probability reversal signal WHEN combined with:
  1. Occurs at a HTF S/R level
  2. Followed by a strong displacement candle in opposite direction
  3. Within a killzone (London 07-10 GMT or NY 12-16 GMT)
- **Killzones:** 70%+ of daily range is set in London + NY sessions. Asian session = accumulation, avoid breakout trades.
- **Silver Bullet** (ICT): 10-11am NY window — first FVG after 10am NY often provides a high-probability entry back in the direction of HTF bias.

## 5. WYCKOFF METHOD — the flow of smart money

### Accumulation schematic (after downtrend)
1. Preliminary Support (PS) — first buying appears.
2. Selling Climax (SC) — max panic, volume spike, price rejection wick.
3. Automatic Rally (AR) — sharp rebound.
4. Secondary Test (ST) — retest of SC low on lower volume.
5. Spring — false break BELOW support (traps shorts). **Highest probability entry.**
6. Sign of Strength (SOS) — breakout with volume.
7. Last Point of Support (LPS) — pullback to breakout level, holds.
8. Markup — trend begins.

### Distribution schematic (mirror image after uptrend)
Buying Climax → Automatic Reaction → Secondary Test → Upthrust After Distribution (UTAD, traps longs) → Sign of Weakness → LPSY → Markdown.

**The Spring and UTAD are among the highest-probability reversal signals in all of technical analysis** — 72% success when accompanied by volume divergence.

## 6. AL BROOKS PRICE ACTION — bar-by-bar rules

- **H1 (High 1):** in an uptrend, the first bar with a higher high after a pullback bar. Entry on break of prior bar's high.
- **L1 (Low 1):** mirror for downtrend.
- **Wedge reversal:** three pushes higher in an uptrend that fail to break out = reversal setup. Enter on break of the wedge's lower trend line.
- **Failed breakout = 5-tick trap.** If price breaks a level by less than 10 pips and reverses, fade the failed breakout — 65% WR.
- **Second entry rule:** if the first entry fails, wait for a second entry in the SAME direction — often the real move.
- **Signal bar quality:** demand a strong close in the direction of the trade (upper 1/3 for longs, lower 1/3 for shorts). Doji signal bars = coin flip.

## 7. CANDLESTICK PATTERNS (Nison) — only at real levels

### Reliable reversal signals (at S/R only)
- **Hammer/Shooting Star:** long wick (≥ 2× body), small body, at extreme of move. Confirmed by next bar closing in reversal direction (adds 15% WR).
- **Bullish/Bearish Engulfing:** body fully covers prior body, at S/R with volume. 63% follow-through 5 bars later.
- **Piercing Line/Dark Cloud Cover:** ≥50% penetration of prior body opposite direction. 60% WR at real levels.
- **Morning Star/Evening Star:** 3-bar pattern with small middle candle. 68% WR at HTF levels.

### Weak / avoid
- **Any single-candle pattern in the middle of a range** — no S/R, no significance.
- **Dojis anywhere except extremes** — indicate indecision, not reversal.
- **Three white soldiers / black crows** — often marks EXHAUSTION, not continuation.

## 8. LINDA RASCHKE — proven short-term setups

- **Turtle Soup:** false breakout of a 20-bar high/low that immediately reverses. Enter on break back inside the range. 68% WR historically.
- **Three-Bar Play (Anti):** in a strong trend, 3 counter-trend bars followed by a resumption bar = entry.
- **Holy Grail:** ADX > 30 + pullback to 20 EMA + engulfing candle. 66% WR trend continuation.

## 9. FIBONACCI — the levels that matter

- **0.382:** shallow retracement, characteristic of STRONG trends.
- **0.500:** median retracement (not a real Fib but institutional attention).
- **0.618:** Golden ratio — the most institutional entry zone in a healthy trend.
- **0.786:** deep retracement — last-defense zone before trend is questioned.
- **1.272, 1.618, 2.618:** extension targets for measured moves.

**Confluence rule:** a Fib level with NO other confluence (S/R, OB, trend line) = weak. Fib + OB + Wyckoff LPS = premium setup.

## 10. MULTI-TIMEFRAME (MTF) ALIGNMENT — the #1 accuracy multiplier

**Bias order (never invert):**
1. Weekly / Daily → direction & regime
2. 4H → structure & swing highs/lows
3. 1H → precise entry level
4. 15m / 5m → entry trigger

Rule: **NEVER take a signal on the entry TF against the daily bias.** This alone eliminates 60% of losing trades.

## 11. MOMENTUM & DIVERGENCE

- **Regular bullish divergence:** price LL + RSI HL → reversal up likely (works best at HTF support).
- **Regular bearish divergence:** price HH + RSI LH → reversal down likely.
- **Hidden bullish:** price HL + RSI LL → CONTINUATION signal in uptrend (trend-follow).
- **Hidden bearish:** price LH + RSI HH → CONTINUATION signal in downtrend.
- **MACD histogram cross:** confirms momentum shift; entries in trend direction on histogram flip.
- **RSI zones for trend confirmation:** in uptrend, RSI oscillates between 40 and 80 (never < 30). In downtrend: 20 to 60 (never > 70).

## 12. VOLUME — the truth serum for price action

- **Volume spike + big candle in direction X + close at extreme = institutional participation.** High-probability continuation.
- **Volume spike + big wick = rejection = reversal signal.**
- **Rising price + falling volume = distribution warning** (buyers exhausting).
- **Falling price + falling volume = capitulation waning = potential bottom.**
- **No supply (small down bar, low volume) at support = Wyckoff bullish signal.**
- **No demand (small up bar, low volume) at resistance = Wyckoff bearish signal.**

## 13. SESSION TIMING — WHEN to trade matters as much as WHAT

- **London open (07:00-08:00 GMT):** 60% of the daily range starts here for EUR, GBP.
- **NY open (12:00-13:00 GMT for winter, 13:00-14:00 GMT for summer):** big moves, especially for USD pairs and gold.
- **London-NY overlap (12:00-16:00 GMT):** peak liquidity, tightest spreads, biggest moves.
- **Asian session:** RANGE bias for USD majors. Momentum works only on JPY and AUD/NZD.
- **NEVER trade breakouts in the last 15 min of a session** — reversals dominate.
- **News event windows:** avoid entering the 15 min before AND after top-tier news (NFP, FOMC, CPI, ECB). Whipsaws destroy stops.

## 14. NEWS & FUNDAMENTAL BIAS

- **Central bank pivots** (dovish → hawkish or vice versa) drive multi-week trends. Trade WITH the pivot.
- **Yield differentials** drive FX pairs medium-term: pair with higher yield (or expected hike) tends to appreciate.
- **Risk-on vs risk-off:** risk-on = AUD, NZD, EUR strong; USD, JPY, CHF weak. Risk-off = mirror.
- **Gold correlations:** inverse to real yields (10Y - CPI) and DXY; positive with geopolitical tension and central bank buying.
- **BTC correlations:** positive with NASDAQ during risk-on; decouples during crypto-specific news.

## 15. RISK MANAGEMENT — the ONLY thing you fully control

- **Position size:** risk 0.5-1% of equity per trade (retail); 0.25-0.5% during losing streaks.
- **R-multiples:** 1R = amount risked. Target 2R+ per trade minimum. If your setup can't offer 2R, it's not a trade.
- **Expectancy:** (WR × avgWin) - (LR × avgLoss). Positive expectancy = tradeable system. Aim for E > 0.3R.
- **Kelly criterion (fractional):** optimal_f = (WR × avgWinR - LR) / avgWinR. Divide by 4 for real trading — full Kelly is emotionally impossible.
- **Max daily loss:** 3R. Hit it and STOP for the day.
- **Max weekly loss:** 6R. Hit it and reduce size by 50% for the next week.
- **Correlation cap:** never have more than 3R combined risk on highly correlated pairs (EURUSD + GBPUSD + AUDUSD all long = one trade, not three).

## 16. STOP-LOSS PLACEMENT

- **Structural SL:** BEHIND the level that invalidates the setup (below OB low for a BUY, above OB high for a SELL). Never round-number stops.
- **ATR-based:** minimum 1.5× ATR to avoid noise stops.
- **Never move SL further from entry** — only closer (break-even after 1R, trail behind swings after 2R).

## 17. TAKE-PROFIT & TRADE MANAGEMENT

- **Partial at TP1 (1R):** de-risks the trade, converts to free option.
- **Move SL to BE at TP1.**
- **Trail behind 1H swing lows/highs for the runner.**
- **Final target = HTF measured move or major S/R.**
- **Never move TP further away** — you're negotiating with the market and it doesn't negotiate.

## 18. THE MENTAL GAME (Mark Douglas five fundamental truths)

1. Anything can happen.
2. You don't need to know what will happen next to make money.
3. There is a random distribution of wins and losses.
4. An edge is nothing more than a higher probability of one thing happening over another.
5. Every moment in the market is unique.

**Practical application:** Judge yourself by ADHERENCE TO YOUR PROCESS, not by trade outcome. A losing trade taken according to plan is a good trade. A winning trade taken outside your plan is a bad trade.

## 19. THINGS THAT LOOK LIKE EDGE BUT AREN'T

- **Any indicator on its own** (RSI 30, MACD cross, MA cross) — WR ≈ 50% out of sample.
- **News trading without directional bias** — reactions are unpredictable in first 5 min.
- **Averaging down** — the fastest way to blow up.
- **Trading during illiquid sessions** — spreads eat the edge.
- **"Feel" or "intuition" without a documented process** — cognitive biases masquerading as skill.
- **Copying other traders' signals without understanding the setup** — you can't manage what you don't understand.

## 20. THE CHECKLIST BEFORE EVERY TRADE

1. What's the regime (trend/range)? Am I using the right playbook?
2. What's the HTF bias? Am I aligned?
3. Where's the invalidation? Is the SL structural?
4. What's my R:R? Is it ≥ 2:1?
5. What's my confidence honestly? If I had to bet 10× the amount, would I still take it?
6. What news is coming in the next 60 minutes? Any tier-1 events?
7. Have I taken more than 2 trades today already? Am I revenge-trading?
8. Is my position size correct (0.5-1% of equity)?

If ANY answer is "I don't know" or "no" — HOLD.
`;

// Helper to get a compact version (for token budget) or full version.
export function getWisdom(mode = 'full') {
  if (mode === 'compact') {
    // Return just section headings for smaller context budgets (e.g. Workers AI 8B)
    return TRADING_WISDOM
      .split('\n')
      .filter(l => l.match(/^## |^### |^\d+\./) && !l.includes('  '))
      .join('\n');
  }
  return TRADING_WISDOM;
}

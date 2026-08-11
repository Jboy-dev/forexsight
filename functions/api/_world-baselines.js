// Baseline win rates per strategy, MEASURED on this engine's exits.
//
// v439 — the published figures previously used here were wrong for this
// system, and wrong by a lot. Each detector was replayed over ~2.8 years of
// real hourly bars across 9 instruments using the exits this app actually
// places (stop at min(1.5xATR, structure, cap); targets at 2/4/7xATR):
//
//   strategy          claimed   measured    gap     n      expectancy
//   ENGULFING            55%      20.1%   -34.9   4786      +0.087R
//   LIQUIDITY_SWEEP      55%      11.3%   -43.7   4446      +0.063R
//   TURTLE_BREAKOUT      55%      21.9%   -33.1   4291      +0.136R
//   HAMMER/STAR          60%      19.4%   -40.6   3848      +0.135R
//   ORB (London)         55%      22.6%   -32.4   2664      +0.196R
//   VWAP_REVERSION       60%      12.0%   -48.0   4966      +0.201R
//   EMA_TREND            55%      21.2%   -33.8   5854      +0.096R
//   RSI_REVERSAL         58%      10.2%   -47.8   2522      +0.219R
//
// The published numbers were not invented — they are real figures for those
// patterns as their authors trade them, with their own targets, usually
// something near 1:1. Transplanting them onto a ladder whose first target
// sits at 2xATR describes a different trade entirely. A 55% strategy taking
// 1R profits is not a 55% strategy when you ask it for 4.7R.
//
// This matters because blendedWR() feeds these numbers into expected-value
// and trust maths. Seeding those with 55-60% when reality is 10-23% made
// every downstream calculation optimistic.
//
// The important finding is that a low strike rate is not a broken strategy:
// every one of these is profitable in expectancy, and every one held its
// sign when the sample was split by time. They earn through the tail — the
// occasional run to 7xATR — not through being right often. Judge them on
// avgR, not wr.
//
// Re-derive with: backtest/strategies.py
//
// Format: { strategyName: { wr: 0-1, avgR: n, source: 'label', notes: '...' } }

export const WORLD_BASELINES = {
  // === ICT / Smart Money Concepts ===
  'ICT': {
    wr: 0.200,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.140,
    source: 'ICT Silver Bullet public backtests (2019-2024)',
    notes: 'measured: closest analogue is the London ORB detector, 22.6% / +0.196R',
  },
  'SMC': {
    wr: 0.110,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.060,
    source: 'ICT/SMC community backtests, Trade Ideas 2023 study',
    notes: 'measured via LIQUIDITY_SWEEP detector: 11.3% / +0.063R',
  },
  // === Opening Range Breakout ===
  'ORB': {
    wr: 0.226,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.196,
    source: 'Toby Crabel research + London/NY session breakout studies',
    notes: 'measured: London opening-range breakout, n=2664',
  },
  // === Momentum / Trend ===
  'MOMENTUM': {
    wr: 0.219,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.136,
    source: 'Encyclopedia of Chart Patterns (Bulkowski)',
    notes: 'measured via TURTLE_BREAKOUT detector: 21.9% / +0.136R',
  },
  'TREND': {
    wr: 0.212,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.096,
    source: 'Turtle Traders backtests, Man AHL trend-following literature',
    notes: 'measured via EMA_TREND detector: 21.2% / +0.096R, n=5854',
  },
  // === Mean Reversion ===
  'RSI_DIVERGENCE': {
    wr: 0.102,   // MEASURED on this engine's exits
    avgR: 0.219,  // expectancy per trade, not R-on-win
    source: 'Bulkowski divergence pattern statistics',
    notes: 'measured via RSI_REVERSAL detector: 10.2% strike rate, +0.219R — the best expectancy of any single detector tested',
  },
  // === Level-based ===
  'VWAP': {
    wr: 0.120,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.201,
    source: 'Institutional VWAP execution research + market microstructure studies',
    notes: 'measured: VWAP reversion beyond 1.5xATR, 12.0% / +0.201R',
  },
  'ORDER_BLOCK': {
    wr: 0.113,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.063,
    source: 'ICT order block backtest community data',
    notes: 'measured via LIQUIDITY_SWEEP detector',
  },
  // === Reversal patterns ===
  'ENGULFING': {
    wr: 0.201,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.087,
    source: 'Nison candlestick studies, Bulkowski (55.4% bull, 55.1% bear)',
    notes: 'measured: n=4786, 20.1% / +0.087R',
  },
  'HAMMER': {
    wr: 0.194,   // MEASURED on this engine's exits (was a published figure)
    avgR: 0.135,
    source: 'Bulkowski hammer statistics (60% bull continuation)',
    notes: 'measured: hammer / shooting star, n=3848',
  },
  // === Chart-read (naive indicator vote) ===
  'CHART-READ': {
    wr: 0.212,   // MEASURED on this engine's exits
    avgR: 0.118,  // expectancy per trade, not R-on-win
    source: 'Local shadow-tracker data (n=164): 29.3% WR',
    notes: 'measured: the composite indicator vote is 21.2% / +0.118R over 5,971 signals',
  },
  'STRONG-READ': {
    wr: 0.225,   // MEASURED on this engine's exits
    avgR: 0.174,  // expectancy per trade, not R-on-win
    source: 'Local data + confluence multi-factor research (median WR ~50%)',
    notes: 'measured: signals with agreement >= 80 reach 22.5% / +0.174R',
  },
  'PREMIUM': {
    wr: 0.235,   // MEASURED on this engine's exits
    avgR: 0.240,  // expectancy per trade, not R-on-win
    source: 'Local + PREMIUM cross-confirmed backtests',
    notes: 'measured: agreement >= 80 + ADX < 30 + outside losing hours = 23.5% / +0.240R',
  },
};

/**
 * Blend local WR with world baseline. Uses Bayesian shrinkage:
 * confidence in local data grows with sample size, capped at 30.
 *
 * @param {number|null} localWR      0-1, from shadow-tracker (or null if unknown)
 * @param {number}      localSamples number of resolved local trades
 * @param {string}      strategyName key into WORLD_BASELINES
 * @returns {{wr:number, source:'local'|'world'|'blend', samplesEffective:number}}
 */
export function blendedWR(localWR, localSamples, strategyName) {
  const baseline = WORLD_BASELINES[strategyName];
  if (!baseline) {
    // Unknown strategy — trust local if we have some, else assume coin flip
    return localSamples >= 3
      ? { wr: localWR, source: 'local', samplesEffective: localSamples }
      : { wr: 0.50, source: 'world', samplesEffective: 0 };
  }
  if (localSamples === 0 || localWR == null) {
    return { wr: baseline.wr, source: 'world', samplesEffective: 0 };
  }
  // Bayesian shrinkage: local trust ramps from 0 (0 samples) to 1 (30+ samples)
  const localWeight = Math.min(1, localSamples / 30);
  const worldWeight = 1 - localWeight;
  const blended = localWR * localWeight + baseline.wr * worldWeight;
  return {
    wr: blended,
    source: localWeight >= 0.8 ? 'local' : localWeight >= 0.3 ? 'blend' : 'world',
    samplesEffective: Math.round(localSamples + 30 * worldWeight),
  };
}

/**
 * Expected value = R:R × WR - (1-WR). Positive = profitable edge.
 * @param {number} rrRatio  R-multiple TP/SL ratio (e.g. 3.0 for 3:1)
 * @param {number} wr       0-1 win probability
 * @returns {number}        Expected R per trade
 */
export function expectedValueR(rrRatio, wr) {
  return rrRatio * wr - 1 * (1 - wr);
}

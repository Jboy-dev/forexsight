// _feature-encoder.js — v361 shared feature-vector encoder.
//
// Both /api/pattern-library (builds the library) and /api/pattern-match
// (matches live state) MUST use identical encoding — otherwise the live
// matcher will never find the historical patterns. This module is the
// single source of truth for the fingerprint format.
//
// Field encoding (deliberately coarse — over-specific fingerprints have
// too few historical samples to be statistically meaningful):
//   R{0-5}     RSI zone: 0=<30, 1=30-40, 2=40-50, 3=50-60, 4=60-70, 5=70+
//   M{-1,0,1}  MACD hist sign: -1=neg, 0=~0, +1=pos
//   A{0-3}     ADX regime: 0=<20, 1=20-25, 2=25-35, 3=>35
//   E20:X      Price vs EMA20 in ATRs, rounded to 0.5, clamped ±3
//   E50:X      Price vs EMA50 in ATRs, rounded to 0.5, clamped ±3
//   E200:X     Price vs EMA200 in ATRs, rounded to 0.5, clamped ±3
//   P{0-4}     Position in 20-bar range: 0=bottom, 1=low, 2=mid, 3=high, 4=top
//   C{0-7}     Last-3-candle direction bitmap (bull=1, bear=0)
//
// Example fingerprint: "R2|M1|A2|E20:0.5|E50:1|E200:2|P3|C7"

export function encodeFingerprint(i, closes, highs, lows, rsi, macd, adx, ema20, ema50, ema200, atr) {
  const price = closes[i];
  if (!isFinite(price) || !isFinite(atr) || atr <= 0) return null;
  if (rsi == null || !isFinite(rsi)) return null;
  if (i < 3) return null;

  // RSI zone (6 buckets)
  let rsiZ;
  if (rsi < 30) rsiZ = 0;
  else if (rsi < 40) rsiZ = 1;
  else if (rsi < 50) rsiZ = 2;
  else if (rsi < 60) rsiZ = 3;
  else if (rsi < 70) rsiZ = 4;
  else rsiZ = 5;

  // MACD sign (3 buckets; small deadzone at ±0.1 to avoid noise)
  const macdSign = macd == null ? 0 : (macd > 0.1 ? 1 : macd < -0.1 ? -1 : 0);

  // ADX regime (4 buckets)
  let adxR;
  if (adx == null) adxR = 0;
  else if (adx < 20) adxR = 0;
  else if (adx < 25) adxR = 1;
  else if (adx < 35) adxR = 2;
  else adxR = 3;

  // EMA distances in ATR — round to 0.5, clamp ±3
  const round05 = (v) => Math.round(v * 2) / 2;
  const clamp3 = (v) => Math.max(-3, Math.min(3, v));
  const emaD20 = ema20 == null ? 0 : clamp3(round05((price - ema20) / atr));
  const emaD50 = ema50 == null ? 0 : clamp3(round05((price - ema50) / atr));
  const emaD200 = ema200 == null ? 0 : clamp3(round05((price - ema200) / atr));

  // Position in 20-bar range (5 buckets)
  const lookback = Math.min(20, i);
  let hi20 = -Infinity, lo20 = Infinity;
  for (let j = i - lookback + 1; j <= i; j++) {
    if (highs[j] > hi20) hi20 = highs[j];
    if (lows[j] < lo20) lo20 = lows[j];
  }
  const rangeSize = hi20 - lo20;
  const posInRange = rangeSize > 0 ? (price - lo20) / rangeSize : 0.5;
  let posR;
  if (posInRange < 0.2) posR = 0;
  else if (posInRange < 0.4) posR = 1;
  else if (posInRange < 0.6) posR = 2;
  else if (posInRange < 0.8) posR = 3;
  else posR = 4;

  // Last 3 candles direction (3-bit bitmap)
  const bull1 = closes[i] > closes[i - 1] ? 1 : 0;
  const bull2 = closes[i - 1] > closes[i - 2] ? 1 : 0;
  const bull3 = closes[i - 2] > closes[i - 3] ? 1 : 0;
  const candles = (bull1 << 2) | (bull2 << 1) | bull3;

  return `R${rsiZ}|M${macdSign}|A${adxR}|E20:${emaD20}|E50:${emaD50}|E200:${emaD200}|P${posR}|C${candles}`;
}

// Parse a fingerprint back into its component fields (for near-match scoring)
export function parseFingerprint(fp) {
  if (!fp || typeof fp !== 'string') return null;
  const parts = fp.split('|');
  if (parts.length !== 8) return null;
  return {
    rsiZ: parseInt(parts[0].slice(1)),
    macdSign: parseInt(parts[1].slice(1)),
    adxR: parseInt(parts[2].slice(1)),
    emaD20: parseFloat(parts[3].slice(4)),
    emaD50: parseFloat(parts[4].slice(4)),
    emaD200: parseFloat(parts[5].slice(5)),
    posR: parseInt(parts[6].slice(1)),
    candles: parseInt(parts[7].slice(1)),
  };
}

// Compare two fingerprints; return number of matching fields (0-8).
// Exact match = 8. Used for near-match scoring in pattern-match.
export function similarity(fpA, fpB) {
  const a = parseFingerprint(fpA);
  const b = parseFingerprint(fpB);
  if (!a || !b) return 0;
  let matches = 0;
  if (a.rsiZ === b.rsiZ) matches++;
  if (a.macdSign === b.macdSign) matches++;
  if (a.adxR === b.adxR) matches++;
  // EMA distances match if within 0.5 ATR (one bucket)
  if (Math.abs(a.emaD20 - b.emaD20) <= 0.5) matches++;
  if (Math.abs(a.emaD50 - b.emaD50) <= 0.5) matches++;
  if (Math.abs(a.emaD200 - b.emaD200) <= 0.5) matches++;
  if (a.posR === b.posR) matches++;
  if (a.candles === b.candles) matches++;
  return matches;
}

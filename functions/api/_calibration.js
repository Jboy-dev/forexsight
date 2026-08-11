// Calibration — turns the engine's raw score into an honest probability.
//
// WHY THIS EXISTS
//
// The engine's "confidence" is the share of indicator weight landing on one
// side: bull / (bull + bear) * 100. That is a measure of AGREEMENT, not a
// probability, and it was being displayed as though it were one. A signal
// badged 90% wins about 22% of the time.
//
// Measured over 5,971 signals / ~2.8 years / 9 instruments (see backtest/):
//
//   raw score 90-100   n=2755   22.5% actually reached a TP before the stop
//   raw score 80-90    n=1276   22.5%
//   raw score 70-80    n=1039   18.6%
//   raw score 60-70    n=425    19.5%
//   raw score 50-60    n=476    18.1%
//
// Four points of spread across a forty-point displayed range.
//
// WHAT WAS TRIED AND REJECTED
//
// A logistic model over score, ADX, RSI, HTF trend, structure, direction,
// hour and pair was fitted on the older half and tested on the newer half.
// It came out ANTI-predictive: AUC 0.492 (below chance), Brier 0.1668
// against 0.1641 for simply predicting the base rate, and its top decile
// won 17.8% while its bottom decile won 23.8%. The apparent in-sample
// discrimination was noise and reversed out of sample. Shipping it would
// have made the displayed number worse than a constant.
//
// WHAT SURVIVED
//
// Only small effects held their direction across both halves:
//
//   score >= 80   +1.7 pts (train)  +0.8 pts (test)
//   ADX < 20      +0.8 pts          +1.3 pts
//   ADX >= 30     -0.5 pts          -1.8 pts
//
// So the honest calibration is the base rate plus a couple of points, and
// the UI should stop implying more precision than that.

const BASE_RATE = 21;      // % of signals reaching any TP before the stop
const FLOOR = 12;
const CEILING = 32;        // no observed cohort beat ~26%; refuse to imply more

/**
 * Probability (%) that a signal reaches a take-profit before its stop.
 * Deliberately narrow — the measured range genuinely is narrow.
 */
export function calibratedProbability({ score, adx } = {}) {
  let p = BASE_RATE;
  if (typeof score === 'number' && score >= 80) p += 1;
  if (typeof adx === 'number') {
    if (adx < 20) p += 1;
    else if (adx >= 30) p -= 2;
  }
  return Math.max(FLOOR, Math.min(CEILING, Math.round(p)));
}

/**
 * The raw score, relabelled for what it actually measures: how much of the
 * indicator weight agrees on this direction. Useful for ranking setups
 * against each other; not a probability of success.
 */
export function agreementLabel(score) {
  if (typeof score !== 'number') return 'unknown';
  if (score >= 90) return 'near-unanimous';
  if (score >= 80) return 'strong';
  if (score >= 70) return 'moderate';
  if (score >= 60) return 'mixed';
  return 'weak';
}

export const CALIBRATION_META = {
  baseRatePct: BASE_RATE,
  sampleSize: 5971,
  sampleSpan: '~2.8 years, 9 instruments, hourly bars',
  note: 'Agreement is not probability. Measured spread across the whole score range is ~4 points.',
};

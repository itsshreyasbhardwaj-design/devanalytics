/**
 * Statistical primitives.
 *
 * Engineering metrics are heavy-tailed and small-sample: one enormous PR or
 * one bad CI day is normal, not anomalous. Mean and standard deviation are
 * dragged around by exactly those points, so the baseline here is built from
 * the median and the median absolute deviation, which a minority of extreme
 * values cannot move.
 */

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2 : (sorted[mid] as number);
}

export function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo] as number;
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Median absolute deviation. */
export function mad(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const m = median(values);
  return median(values.map((v) => Math.abs(v - m)));
}

/** 1 / Φ⁻¹(0.75): scales MAD to be a consistent estimator of σ for normal data. */
export const MAD_TO_SIGMA = 1.4826;

/**
 * Modified z-score.
 *
 * Returns null when the baseline has no spread at all (every historical value
 * identical), because any deviation would otherwise score as infinite.
 */
export function modifiedZScore(value: number, baseline: readonly number[]): number | null {
  if (baseline.length === 0) return null;
  const m = median(baseline);
  const scale = mad(baseline) * MAD_TO_SIGMA;
  if (scale === 0 || !Number.isFinite(scale)) {
    // Fall back to a relative comparison so a genuinely flat baseline with a
    // large jump is still detectable, rather than silently unscorable.
    if (m === 0) return null;
    const relative = (value - m) / Math.abs(m);
    return Math.abs(relative) > 0.5 ? relative * 3 : 0;
  }
  return (value - m) / scale;
}

/**
 * Exponentially weighted moving average.
 *
 * Used as a secondary baseline: it reacts to a real level shift faster than a
 * rolling median, so agreement between the two raises confidence and
 * disagreement lowers it.
 */
export function ewma(values: readonly number[], alpha = 0.3): number {
  if (values.length === 0) return Number.NaN;
  let acc = values[0] as number;
  for (let i = 1; i < values.length; i++) acc = alpha * (values[i] as number) + (1 - alpha) * acc;
  return acc;
}

/**
 * Two-proportion z-test.
 *
 * Rate metrics (build success, failed deployments) are counts, not continuous
 * quantities: 3 failures out of 4 runs and 300 out of 400 are the same ratio
 * with wildly different evidence. This scores the difference in a way that
 * accounts for how many runs there actually were.
 */
export function proportionZTest(
  successesA: number, totalA: number,
  successesB: number, totalB: number,
): number | null {
  if (totalA === 0 || totalB === 0) return null;
  const pA = successesA / totalA;
  const pB = successesB / totalB;
  const pooled = (successesA + successesB) / (totalA + totalB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / totalA + 1 / totalB));
  if (se === 0 || !Number.isFinite(se)) return null;
  return (pA - pB) / se;
}

/** Two-sided normal tail probability; good to ~7 decimal places. */
export function normalTwoSidedP(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  // Abramowitz & Stegun 7.1.26 approximation of erf.
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return Math.max(0, Math.min(1, 1 - y));
}

export interface Baseline {
  median: number;
  mad: number;
  ewma: number;
  p25: number;
  p75: number;
  sampleSize: number;
}

export function describeBaseline(values: readonly number[]): Baseline {
  return {
    median: median(values),
    mad: mad(values),
    ewma: ewma(values),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    sampleSize: values.length,
  };
}

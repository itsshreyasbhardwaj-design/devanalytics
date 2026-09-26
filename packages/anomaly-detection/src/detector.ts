import {
  describeBaseline,
  modifiedZScore,
  normalTwoSidedP,
  proportionZTest,
  type Baseline,
} from './statistics.js';

/**
 * Anomaly detection.
 *
 * Three ideas, in order of importance:
 *
 * 1. No fixed thresholds. "Cycle time over 48 hours" is meaningless across
 *    repositories. Every judgement is relative to that scope's own history.
 * 2. Statistical *and* practical significance. A 2% move can be statistically
 *    detectable in a high-volume repository and still not worth a human's
 *    attention, so a minimum effect size has to be cleared too.
 * 3. Sample size is part of the answer, never hidden. A detection carries the
 *    number of observations behind it and a confidence grade derived from
 *    them, so a reader can discount a thin week themselves.
 */

export type Aggregation = 'mean' | 'rate' | 'per_day' | 'median';

export interface BucketObservation {
  bucketStart: string;
  value: number | null;
  sampleSize: number;
  numerator: number | null;
  denominator: number | null;
}

export interface DetectionInput {
  metric: string;
  aggregation: Aggregation;
  direction: 'lower_is_better' | 'higher_is_better' | 'neutral';
  /** Historical buckets, ascending, excluding the bucket under test. */
  history: BucketObservation[];
  current: BucketObservation;
  options?: Partial<DetectorOptions>;
}

export interface DetectorOptions {
  /** Buckets of history required before any detection is attempted. */
  minBaselineBuckets: number;
  /** |modified z| at which a deviation is considered statistically unusual. */
  scoreThreshold: number;
  /** Minimum relative change before a deviation is worth surfacing. */
  minRelativeChange: number;
  /** Observations required in the bucket under test. */
  minCurrentSample: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  minBaselineBuckets: 14,
  scoreThreshold: 3.5,
  minRelativeChange: 0.15,
  minCurrentSample: 5,
};

export type NotDetectedReason =
  | 'insufficient_baseline'
  | 'insufficient_current_sample'
  | 'no_baseline_spread'
  | 'below_score_threshold'
  | 'below_effect_size';

export interface Detection {
  metric: string;
  isAnomaly: boolean;
  /** Present when isAnomaly is false, so the UI can say why nothing fired. */
  reason?: NotDetectedReason;
  observedValue: number;
  baselineValue: number;
  baseline: Baseline;
  score: number;
  pValue: number | null;
  relativeChange: number;
  direction: 'increase' | 'decrease';
  /** Whether the movement is in the metric's good direction. */
  isImprovement: boolean;
  severity: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  sampleSize: number;
  baselineSampleSize: number;
  method: 'modified_z' | 'two_proportion_z';
  /** Plain-language statement of what was compared. Rendered verbatim in the UI. */
  explanation: string;
}

export function detect(input: DetectionInput): Detection | null {
  const opts = { ...DEFAULT_DETECTOR_OPTIONS, ...(input.options ?? {}) };
  const usable = input.history.filter((h) => h.value !== null && h.sampleSize > 0);
  const values = usable.map((h) => h.value as number);
  const baseline = describeBaseline(values);
  const baselineSampleSize = usable.reduce((a, h) => a + h.sampleSize, 0);
  const observedValue = input.current.value;

  if (observedValue === null) return null;

  const base = {
    metric: input.metric,
    observedValue,
    baselineValue: baseline.median,
    baseline,
    sampleSize: input.current.sampleSize,
    baselineSampleSize,
    relativeChange: baseline.median === 0 ? 0 : (observedValue - baseline.median) / Math.abs(baseline.median),
    direction: (observedValue >= baseline.median ? 'increase' : 'decrease') as 'increase' | 'decrease',
  };
  const isImprovement =
    input.direction === 'neutral'
      ? false
      : input.direction === 'lower_is_better'
        ? base.direction === 'decrease'
        : base.direction === 'increase';

  const reject = (reason: NotDetectedReason): Detection => ({
    ...base,
    isAnomaly: false,
    reason,
    score: 0,
    pValue: null,
    isImprovement,
    severity: 'low',
    confidence: 'low',
    method: input.aggregation === 'rate' ? 'two_proportion_z' : 'modified_z',
    explanation: explain(input.metric, reason, base, usable.length, opts),
  });

  if (usable.length < opts.minBaselineBuckets) return reject('insufficient_baseline');
  if (input.current.sampleSize < opts.minCurrentSample) return reject('insufficient_current_sample');

  // Rate metrics are counts: compare proportions with their denominators
  // rather than treating each day's ratio as an independent measurement.
  let score: number | null;
  let method: Detection['method'];
  if (input.aggregation === 'rate') {
    method = 'two_proportion_z';
    const histNum = usable.reduce((a, h) => a + (h.numerator ?? 0), 0);
    const histDen = usable.reduce((a, h) => a + (h.denominator ?? 0), 0);
    score = proportionZTest(
      input.current.numerator ?? 0,
      input.current.denominator ?? 0,
      histNum,
      histDen,
    );
  } else {
    method = 'modified_z';
    score = modifiedZScore(observedValue, values);
  }

  if (score === null) return { ...reject('no_baseline_spread'), method };

  const absScore = Math.abs(score);
  const absRelative = Math.abs(base.relativeChange);
  const pValue = normalTwoSidedP(score);

  if (absScore < opts.scoreThreshold) {
    return { ...reject('below_score_threshold'), score, pValue, method };
  }
  if (absRelative < opts.minRelativeChange) {
    return { ...reject('below_effect_size'), score, pValue, method };
  }

  const severity: Detection['severity'] = absScore >= 6 || absRelative >= 0.75 ? 'high' : absScore >= 4.5 || absRelative >= 0.35 ? 'medium' : 'low';
  // Confidence is about how much we know, not how big the move is.
  const confidence: Detection['confidence'] =
    usable.length >= 28 && input.current.sampleSize >= opts.minCurrentSample * 4
      ? 'high'
      : usable.length >= 21 && input.current.sampleSize >= opts.minCurrentSample * 2
        ? 'medium'
        : 'low';

  return {
    ...base,
    isAnomaly: true,
    score,
    pValue,
    isImprovement,
    severity,
    confidence,
    method,
    explanation: explain(input.metric, null, base, usable.length, opts),
  };
}

function explain(
  metric: string,
  reason: NotDetectedReason | null,
  base: { observedValue: number; baselineValue: number; relativeChange: number; sampleSize: number; direction: string },
  baselineBuckets: number,
  opts: DetectorOptions,
): string {
  const pct = `${(base.relativeChange * 100).toFixed(1)}%`;
  switch (reason) {
    case 'insufficient_baseline':
      return `Not evaluated: ${baselineBuckets} historical buckets available, ${opts.minBaselineBuckets} required to establish a baseline for ${metric}.`;
    case 'insufficient_current_sample':
      return `Not evaluated: only ${base.sampleSize} observations in the period, ${opts.minCurrentSample} required.`;
    case 'no_baseline_spread':
      return `Not evaluated: the historical baseline for ${metric} has no measurable spread, so a deviation cannot be scored.`;
    case 'below_score_threshold':
      return `Within normal variation: ${pct} versus the historical median, which this scope's own history does not treat as unusual.`;
    case 'below_effect_size':
      return `Statistically detectable but small: ${pct} change is below the ${(opts.minRelativeChange * 100).toFixed(0)}% effect size required to raise an anomaly.`;
    default:
      return `${base.direction === 'increase' ? 'Increased' : 'Decreased'} ${pct} against a baseline of ${baselineBuckets} prior periods, based on ${base.sampleSize} observations.`;
  }
}

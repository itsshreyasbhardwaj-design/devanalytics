/**
 * Metric results are an explicit sum type.
 *
 * A metric is either computed from real ingested rows, or it is *not available*.
 * There is no third state where we invent a number. Every consumer — API, SDK,
 * dashboard, MCP, AI — has to handle `insufficient_data` to render anything,
 * which is what structurally prevents fabricated statistics from reaching a user.
 */

export type InsufficientReason =
  | 'no_data'
  | 'below_minimum_sample'
  | 'no_baseline'
  | 'metric_not_supported_for_scope';

export interface MetricOk {
  status: 'ok';
  /** The computed value in the metric's declared unit. */
  value: number;
  /** Number of underlying records the value was computed from. */
  sampleSize: number;
}

export interface MetricInsufficient {
  status: 'insufficient_data';
  reason: InsufficientReason;
  /** How many records we actually had. */
  sampleSize: number;
  /** How many we needed. */
  minimumSampleSize: number;
}

export type MetricResult = MetricOk | MetricInsufficient;

export function ok(value: number, sampleSize: number): MetricOk {
  return { status: 'ok', value, sampleSize };
}

export function insufficient(
  reason: InsufficientReason,
  sampleSize: number,
  minimumSampleSize: number,
): MetricInsufficient {
  return { status: 'insufficient_data', reason, sampleSize, minimumSampleSize };
}

export function isOk(r: MetricResult): r is MetricOk {
  return r.status === 'ok';
}

/** Human-facing label. The UI must never substitute 0 or "—" silently for this. */
export const INSUFFICIENT_DATA_LABEL = 'Insufficient data';

export interface Comparison {
  current: MetricResult;
  previous: MetricResult;
  /** Absolute delta (current - previous), only when both sides are `ok`. */
  absoluteChange: number | null;
  /** Relative delta as a fraction (0.31 = +31%), only when both sides are `ok` and previous != 0. */
  relativeChange: number | null;
  direction: 'up' | 'down' | 'flat' | 'unknown';
}

export function compare(current: MetricResult, previous: MetricResult): Comparison {
  if (!isOk(current) || !isOk(previous)) {
    return { current, previous, absoluteChange: null, relativeChange: null, direction: 'unknown' };
  }
  const absoluteChange = current.value - previous.value;
  const relativeChange = previous.value === 0 ? null : absoluteChange / previous.value;
  const eps = 1e-9;
  const direction = absoluteChange > eps ? 'up' : absoluteChange < -eps ? 'down' : 'flat';
  return { current, previous, absoluteChange, relativeChange, direction };
}

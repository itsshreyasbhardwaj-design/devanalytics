import { INSUFFICIENT_DATA_LABEL, type MetricResult } from '@devanalytics/core';
import { requireMetricDefinition } from './definitions.js';

/**
 * Presentation.
 *
 * `insufficient_data` formats as the words "Insufficient data" in every
 * surface. It never formats as 0, "-", or an empty chart point, because those
 * read as measurements.
 */
export function formatMetric(metric: string, result: MetricResult): string {
  if (result.status !== 'ok') return INSUFFICIENT_DATA_LABEL;
  return formatValue(metric, result.value);
}

export function formatValue(metric: string, value: number): string {
  const def = requireMetricDefinition(metric);
  switch (def.unit) {
    case 'hours':
      return value < 1 ? `${Math.round(value * 60)} min` : value < 48 ? `${value.toFixed(1)} h` : `${(value / 24).toFixed(1)} d`;
    case 'minutes':
      return value < 60 ? `${value.toFixed(1)} min` : `${(value / 60).toFixed(1)} h`;
    case 'lines':
      return `${Math.round(value).toLocaleString('en-US')} lines`;
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
    case 'per_day':
      return value >= 1 ? `${value.toFixed(2)}/day` : `${(value * 7).toFixed(2)}/week`;
    case 'count_per_pr':
      return `${value.toFixed(2)} per PR`;
    case 'count':
      return Math.round(value).toLocaleString('en-US');
  }
}

export function formatChange(relativeChange: number | null): string {
  if (relativeChange === null) return '—';
  const pct = relativeChange * 100;
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

/** Whether a movement is good, bad or neither, per the metric's declared direction. */
export function changeSentiment(metric: string, relativeChange: number | null): 'good' | 'bad' | 'neutral' {
  if (relativeChange === null || Math.abs(relativeChange) < 0.01) return 'neutral';
  const dir = requireMetricDefinition(metric).direction;
  if (dir === 'neutral') return 'neutral';
  const improving = dir === 'lower_is_better' ? relativeChange < 0 : relativeChange > 0;
  return improving ? 'good' : 'bad';
}

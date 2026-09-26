import { describe, it, expect } from 'vitest';
import { detect, type BucketObservation } from '@devanalytics/anomaly-detection';

const bucket = (i: number, value: number | null, sampleSize = 10, numerator?: number, denominator?: number): BucketObservation => ({
  bucketStart: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
  value,
  sampleSize,
  numerator: numerator ?? (value === null ? null : value * sampleSize),
  denominator: denominator ?? sampleSize,
});

const steady = (n: number, value: number, jitter = 0.4) =>
  Array.from({ length: n }, (_, i) => bucket(i, value + ((i % 3) - 1) * jitter));

describe('anomaly detection', () => {
  it('declines to judge without enough history', () => {
    const d = detect({
      metric: 'pr_cycle_time', aggregation: 'median', direction: 'lower_is_better',
      history: steady(5, 10), current: bucket(99, 40),
    });
    expect(d?.isAnomaly).toBe(false);
    expect(d?.reason).toBe('insufficient_baseline');
    expect(d?.explanation).toMatch(/5 historical buckets available, 14 required/);
  });

  it('declines to judge a thin current period', () => {
    const d = detect({
      metric: 'pr_cycle_time', aggregation: 'median', direction: 'lower_is_better',
      history: steady(20, 10), current: bucket(99, 40, 2),
    });
    expect(d?.reason).toBe('insufficient_current_sample');
  });

  it('flags a genuine regression and names its direction', () => {
    const d = detect({
      metric: 'pr_cycle_time', aggregation: 'median', direction: 'lower_is_better',
      history: steady(30, 10), current: bucket(99, 22, 25),
    });
    expect(d?.isAnomaly).toBe(true);
    expect(d?.direction).toBe('increase');
    expect(d?.isImprovement).toBe(false);
    expect(d?.severity).toBe('high');
    expect(d?.confidence).toBe('high');
    expect(Math.abs(d?.score ?? 0)).toBeGreaterThan(3.5);
    expect(d?.explanation).toMatch(/Increased 120\.0% against a baseline of 30 prior periods/);
  });

  it('flags an improvement as an anomaly but labels it an improvement', () => {
    const d = detect({
      metric: 'pr_cycle_time', aggregation: 'median', direction: 'lower_is_better',
      history: steady(30, 20), current: bucket(99, 4, 25),
    });
    expect(d?.isAnomaly).toBe(true);
    expect(d?.direction).toBe('decrease');
    expect(d?.isImprovement).toBe(true);
  });

  it('does not fire on normal variation', () => {
    const d = detect({
      metric: 'pr_cycle_time', aggregation: 'median', direction: 'lower_is_better',
      history: steady(30, 10), current: bucket(99, 10.3, 25),
    });
    expect(d?.isAnomaly).toBe(false);
    expect(d?.reason).toBe('below_score_threshold');
  });

  it('suppresses a statistically detectable but trivially small change', () => {
    // Extremely tight history makes a 5% move statistically extreme.
    const history = Array.from({ length: 30 }, (_, i) => bucket(i, 10 + (i % 2) * 0.01));
    const d = detect({
      metric: 'build_duration', aggregation: 'median', direction: 'lower_is_better',
      history, current: bucket(99, 10.5, 40),
    });
    expect(Math.abs(d?.score ?? 0)).toBeGreaterThan(3.5);
    expect(d?.isAnomaly).toBe(false);
    expect(d?.reason).toBe('below_effect_size');
  });

  it('weighs rate metrics by their denominators, not their ratios', () => {
    // 90% success for 30 days at 100 runs/day, then a 60% day.
    const history = Array.from({ length: 30 }, (_, i) => bucket(i, 0.9, 100, 90, 100));
    const thinDay = detect({
      metric: 'build_success_rate', aggregation: 'rate', direction: 'higher_is_better',
      history, current: bucket(99, 0.6, 5, 3, 5),
    });
    const busyDay = detect({
      metric: 'build_success_rate', aggregation: 'rate', direction: 'higher_is_better',
      history, current: bucket(99, 0.6, 100, 60, 100),
    });
    expect(thinDay?.method).toBe('two_proportion_z');
    // Same ratio, far more evidence on the busy day.
    expect(Math.abs(busyDay?.score ?? 0)).toBeGreaterThan(Math.abs(thinDay?.score ?? 0));
    expect(busyDay?.isAnomaly).toBe(true);
  });

  it('never scores a flat all-zero baseline as infinitely anomalous', () => {
    const history = Array.from({ length: 30 }, (_, i) => bucket(i, 0, 10, 0, 10));
    const d = detect({
      metric: 'failed_deployment_rate', aggregation: 'median', direction: 'lower_is_better',
      history, current: bucket(99, 0.5, 20),
    });
    expect(d?.reason).toBe('no_baseline_spread');
    expect(Number.isFinite(d?.score ?? 0)).toBe(true);
  });

  it('reports sample sizes alongside every verdict', () => {
    const d = detect({
      metric: 'pr_cycle_time', aggregation: 'median', direction: 'lower_is_better',
      history: steady(30, 10), current: bucket(99, 25, 12),
    });
    expect(d?.sampleSize).toBe(12);
    expect(d?.baselineSampleSize).toBe(300);
    expect(d?.baseline.sampleSize).toBe(30);
  });
});

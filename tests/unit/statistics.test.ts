import { describe, it, expect } from 'vitest';
import {
  ewma, mad, mean, median, modifiedZScore, normalTwoSidedP, proportionZTest, quantile,
} from '@devanalytics/anomaly-detection';

describe('statistical primitives', () => {
  it('computes medians for odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNaN();
  });

  it('interpolates quantiles', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([0, 10], 0.25)).toBe(2.5);
  });

  it('computes the median absolute deviation', () => {
    // median is 3; deviations [2,1,0,1,2]; median of those is 1.
    expect(mad([1, 2, 3, 4, 5])).toBe(1);
  });

  it('resists outliers where mean and standard deviation do not', () => {
    const calm = [10, 10, 11, 9, 10, 10, 11, 9];
    const withSpike = [...calm, 400];
    // The mean moves by tens; the median barely moves at all.
    expect(mean(withSpike) - mean(calm)).toBeGreaterThan(30);
    expect(Math.abs(median(withSpike) - median(calm))).toBeLessThanOrEqual(0.5);
  });

  it('scores a deviation against a robust baseline', () => {
    const baseline = [10, 10, 11, 9, 10, 10, 11, 9];
    const z = modifiedZScore(20, baseline);
    expect(z).not.toBeNull();
    expect(z as number).toBeGreaterThan(5);
    expect(modifiedZScore(10, baseline) as number).toBeCloseTo(0, 6);
  });

  it('refuses to score against a degenerate baseline of identical zeros', () => {
    expect(modifiedZScore(5, [0, 0, 0, 0])).toBeNull();
    expect(modifiedZScore(5, [])).toBeNull();
  });

  it('still detects a large jump from a perfectly flat non-zero baseline', () => {
    const z = modifiedZScore(20, [10, 10, 10, 10]);
    expect(z).not.toBeNull();
    expect(z as number).toBeGreaterThan(1);
    // A small wobble on a flat baseline is not an anomaly.
    expect(modifiedZScore(10.2, [10, 10, 10, 10])).toBe(0);
  });

  it('weights recent observations more heavily in the EWMA', () => {
    expect(ewma([10, 10, 10])).toBeCloseTo(10, 6);
    expect(ewma([10, 10, 20])).toBeGreaterThan(10);
    expect(ewma([10, 10, 20])).toBeLessThan(20);
  });

  it('accounts for sample size when comparing rates', () => {
    // Same ratios, different evidence.
    const small = proportionZTest(3, 4, 9, 10) as number;
    const large = proportionZTest(300, 400, 900, 1000) as number;
    expect(Math.abs(large)).toBeGreaterThan(Math.abs(small));
    expect(proportionZTest(1, 0, 1, 1)).toBeNull();
  });

  it('converts z-scores to two-sided p-values', () => {
    expect(normalTwoSidedP(0)).toBeCloseTo(1, 3);
    expect(normalTwoSidedP(1.96)).toBeCloseTo(0.05, 2);
    expect(normalTwoSidedP(3)).toBeLessThan(0.01);
  });
});

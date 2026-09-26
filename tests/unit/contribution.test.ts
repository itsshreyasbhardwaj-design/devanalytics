import { describe, it, expect } from 'vitest';
import {
  assertNonCausal, correlation, correlationStrength, decompose, type GroupStats,
} from '@devanalytics/investigations';

const g = (key: string, mean: number, count: number): GroupStats => ({
  key, label: key, numerator: mean * count, denominator: count, sampleSize: count,
});

describe('contribution decomposition', () => {
  it('accounts for the entire delta with no residual', () => {
    const baseline = [g('api', 10, 50), g('web', 10, 50)];
    const current = [g('api', 30, 50), g('web', 10, 50)];
    const d = decompose(current, baseline);
    expect(d.baselineValue).toBeCloseTo(10, 9);
    expect(d.currentValue).toBeCloseTo(20, 9);
    expect(d.delta).toBeCloseTo(10, 9);
    expect(d.residual).toBeCloseTo(0, 9);
    expect(d.contributions.reduce((a, c) => a + c.contribution, 0)).toBeCloseTo(10, 9);
  });

  it('attributes a single slow repository to that repository', () => {
    const d = decompose([g('api', 30, 50), g('web', 10, 50)], [g('api', 10, 50), g('web', 10, 50)]);
    const top = d.contributions[0];
    expect(top?.key).toBe('api');
    expect(top?.contributionShare).toBeCloseTo(1, 9);
    // The repository itself got slower; its share of volume did not change.
    expect(top?.rateEffect).toBeCloseTo(10, 9);
    expect(top?.mixEffect).toBeCloseTo(0, 9);
  });

  it('separates a group getting slower from a group getting bigger', () => {
    // Neither group changed its own value; the slow one just produced far more.
    const baseline = [g('slow', 40, 10), g('fast', 5, 90)];
    const current = [g('slow', 40, 50), g('fast', 5, 50)];
    const d = decompose(current, baseline);
    const slow = d.contributions.find((c) => c.key === 'slow');
    expect(slow?.currentValue).toBeCloseTo(40, 9);
    expect(slow?.baselineValue).toBeCloseTo(40, 9);
    expect(slow?.rateEffect).toBeCloseTo(0, 9);
    expect(slow?.mixEffect).toBeGreaterThan(0);
    expect(d.residual).toBeCloseTo(0, 9);
  });

  it('handles groups that appear or vanish between periods', () => {
    const d = decompose([g('a', 10, 50), g('new', 40, 50)], [g('a', 10, 50), g('gone', 10, 50)]);
    expect(d.residual).toBeCloseTo(0, 9);
    const gone = d.contributions.find((c) => c.key === 'gone');
    expect(gone?.currentValue).toBeNull();
    const created = d.contributions.find((c) => c.key === 'new');
    expect(created?.baselineValue).toBeNull();
  });

  it('marks groups moving against the trend with a negative share', () => {
    const d = decompose([g('up', 40, 50), g('down', 5, 50)], [g('up', 10, 50), g('down', 10, 50)]);
    expect((d.delta as number) > 0).toBe(true);
    expect(d.contributions.find((c) => c.key === 'down')?.contributionShare).toBeLessThan(0);
  });

  it('returns no decomposition rather than a fabricated one when a period is empty', () => {
    const d = decompose([], [g('a', 10, 50)]);
    expect(d.delta).toBeNull();
    expect(d.contributions).toEqual([]);
  });
});

describe('correlation', () => {
  it('detects a perfect linear relationship', () => {
    expect(correlation([1, 2, 3, 4], [2, 4, 6, 8]) as number).toBeCloseTo(1, 9);
    expect(correlation([1, 2, 3, 4], [8, 6, 4, 2]) as number).toBeCloseTo(-1, 9);
  });

  it('refuses to report a correlation from too few points or a flat series', () => {
    expect(correlation([1, 2], [1, 2])).toBeNull();
    expect(correlation([1, 1, 1, 1], [1, 2, 3, 4])).toBeNull();
  });

  it('labels strength conservatively', () => {
    expect(correlationStrength(0.2)).toBe('negligible');
    expect(correlationStrength(0.45)).toBe('weak');
    expect(correlationStrength(0.65)).toBe('moderate');
    expect(correlationStrength(-0.9)).toBe('strong');
  });
});

describe('causal language guard', () => {
  it('allows associative phrasing', () => {
    expect(assertNonCausal('acme/api accounts for 62% of the change')).toContain('accounts for');
    expect(assertNonCausal('PR size correlates with the change over the same period')).toContain('correlates');
  });

  it('rejects causal phrasing', () => {
    expect(() => assertNonCausal('The CI slowdown caused the cycle time increase')).toThrow(/causal claim/);
    expect(() => assertNonCausal('Cycle time rose due to larger PRs')).toThrow(/causal claim/);
    expect(() => assertNonCausal('Larger reviews led to slower merges')).toThrow(/causal claim/);
  });
});

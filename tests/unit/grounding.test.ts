import { describe, it, expect } from 'vitest';
import { containsCausalClaim, verifyGrounding, type EvidenceBundle } from '@devanalytics/ai';

const bundle = (values: number[], sampleSize = 42): EvidenceBundle => ({
  plan: {
    orgId: 'o', intent: 'investigate', metric: 'pr_cycle_time', scopeType: 'org', scopeId: 'o',
    scopeHint: null, window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
    period: '30d', dimension: 'repository', interpretation: '', confidence: 'high', unresolved: [],
  },
  empty: false,
  citations: [
    {
      id: 'c1', kind: 'metric', metric: 'pr_cycle_time', scope: 'org',
      window: { from: '2026-08-01T00:00:00.000Z', to: '2026-09-01T00:00:00.000Z' },
      statement: 'stated', values, sampleSize, href: null,
    },
  ],
  investigation: null,
  series: [],
  notes: [],
});

describe('grounding verification', () => {
  it('accepts an answer whose figures all come from the evidence', () => {
    const r = verifyGrounding('Cycle time is 12.6 hours across 42 observations.', bundle([12.6]));
    expect(r.grounded).toBe(true);
    expect(r.unsupported).toEqual([]);
    expect(r.checked).toBeGreaterThan(0);
  });

  it('rejects an answer containing a fabricated figure', () => {
    const r = verifyGrounding('Cycle time is 12.6 hours, up 31% from last month.', bundle([12.6]));
    expect(r.grounded).toBe(false);
    expect(r.unsupported).toContain(31);
  });

  it('allows minor rounding of a supported figure', () => {
    expect(verifyGrounding('roughly 12.6 hours', bundle([12.63])).grounded).toBe(true);
    expect(verifyGrounding('13 hours', bundle([12.63])).grounded).toBe(true);
  });

  it('does not treat dates or years as claims', () => {
    const r = verifyGrounding('Between 2026-08-01 and 2026-09-01 the value was 12.6.', bundle([12.6]));
    expect(r.grounded).toBe(true);
  });

  it('checks sample sizes too', () => {
    expect(verifyGrounding('based on 42 pull requests', bundle([12.6], 42)).grounded).toBe(true);
    expect(verifyGrounding('based on 900 pull requests', bundle([12.6], 42)).grounded).toBe(false);
  });

  it('flags causal language', () => {
    expect(containsCausalClaim('Larger PRs caused the slowdown')).toBe(true);
    expect(containsCausalClaim('The slowdown was due to CI')).toBe(true);
    expect(containsCausalClaim('Larger PRs are associated with the slowdown')).toBe(false);
    expect(containsCausalClaim('northwind/checkout accounts for 62% of the change')).toBe(false);
  });
});

describe('grounding verification: identifiers versus magnitudes', () => {
  const b = bundle([12.6], 42);

  it('ignores citation markers, PR numbers, links and shas', () => {
    const text = 'Cycle time is 12.6 hours [F1]. See acme/api#684 ([open](/pull-requests/3932ae6b3b277a45becbcddd0827f054)) and sha 1a2b3c4d5e6f.';
    expect(verifyGrounding(text, b).grounded).toBe(true);
  });

  it('still catches a fabricated magnitude in the same sentence as an identifier', () => {
    const text = 'acme/api#684 [F1] took 99.9 hours.';
    const r = verifyGrounding(text, b);
    expect(r.grounded).toBe(false);
    expect(r.unsupported).toContain(99.9);
  });
});

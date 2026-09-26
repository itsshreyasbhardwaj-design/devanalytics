/**
 * Contribution analysis.
 *
 * When an aggregate metric moves, the useful question is not "what else moved
 * at the same time" but "how much of *this* delta is arithmetically accounted
 * for by each slice". For any metric of the form
 *
 *     M = sum(numerator) / sum(denominator)
 *
 * the aggregate is a denominator-weighted average of its groups:
 *
 *     M = Σ_g w_g · m_g        where w_g = den_g / Σ den,  m_g = num_g / den_g
 *
 * so the change decomposes exactly, with no residual:
 *
 *     ΔM = Σ_g ( w_g,cur · m_g,cur − w_g,base · m_g,base )
 *
 * and each group's term splits further into
 *
 *     rate effect = w_g,base · (m_g,cur − m_g,base)   the group itself changed
 *     mix  effect = (w_g,cur − w_g,base) · m_g,cur    the group's share changed
 *
 * The distinction matters: a repository whose reviews got slower and a
 * repository that merely started producing more of the organization's pull
 * requests look identical in a naive breakdown, and they need different
 * responses.
 */

export interface GroupStats {
  key: string;
  label: string;
  numerator: number;
  denominator: number;
  sampleSize: number;
}

export interface Contribution {
  key: string;
  label: string;
  currentValue: number | null;
  baselineValue: number | null;
  /** Share of the total delta attributable to this group (same units as the metric). */
  contribution: number;
  /** Of that contribution, the part caused by the group's own value changing. */
  rateEffect: number;
  /** Of that contribution, the part caused by the group's share of volume changing. */
  mixEffect: number;
  /** Fraction of the total movement, signed. Groups moving against the trend are negative. */
  contributionShare: number;
  currentWeight: number;
  baselineWeight: number;
  sampleSize: number;
  baselineSampleSize: number;
}

export interface Decomposition {
  currentValue: number | null;
  baselineValue: number | null;
  delta: number | null;
  contributions: Contribution[];
  /** Always ~0 for weighted-average metrics; kept so a bad decomposition is visible rather than silent. */
  residual: number;
}

export function decompose(current: GroupStats[], baseline: GroupStats[]): Decomposition {
  const curDen = current.reduce((a, g) => a + g.denominator, 0);
  const baseDen = baseline.reduce((a, g) => a + g.denominator, 0);
  const curNum = current.reduce((a, g) => a + g.numerator, 0);
  const baseNum = baseline.reduce((a, g) => a + g.numerator, 0);

  if (curDen === 0 || baseDen === 0) {
    return {
      currentValue: curDen === 0 ? null : curNum / curDen,
      baselineValue: baseDen === 0 ? null : baseNum / baseDen,
      delta: null,
      contributions: [],
      residual: 0,
    };
  }

  const currentValue = curNum / curDen;
  const baselineValue = baseNum / baseDen;
  const delta = currentValue - baselineValue;

  const curBy = new Map(current.map((g) => [g.key, g]));
  const baseBy = new Map(baseline.map((g) => [g.key, g]));
  const keys = [...new Set([...curBy.keys(), ...baseBy.keys()])];

  const contributions: Contribution[] = keys.map((key) => {
    const c = curBy.get(key);
    const b = baseBy.get(key);
    const wCur = c ? c.denominator / curDen : 0;
    const wBase = b ? b.denominator / baseDen : 0;
    const mCur = c && c.denominator > 0 ? c.numerator / c.denominator : 0;
    const mBase = b && b.denominator > 0 ? b.numerator / b.denominator : 0;

    const contribution = wCur * mCur - wBase * mBase;
    const rateEffect = wBase * (mCur - mBase);
    const mixEffect = (wCur - wBase) * mCur;

    return {
      key,
      label: c?.label ?? b?.label ?? key,
      currentValue: c && c.denominator > 0 ? mCur : null,
      baselineValue: b && b.denominator > 0 ? mBase : null,
      contribution,
      rateEffect,
      mixEffect,
      contributionShare: delta === 0 ? 0 : contribution / delta,
      currentWeight: wCur,
      baselineWeight: wBase,
      sampleSize: c?.sampleSize ?? 0,
      baselineSampleSize: b?.sampleSize ?? 0,
    };
  });

  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  const residual = delta - contributions.reduce((a, c) => a + c.contribution, 0);
  return { currentValue, baselineValue, delta, contributions, residual };
}

/**
 * Pearson correlation over paired observations.
 *
 * Used only to rank *candidate* explanations for a human to consider. A
 * correlation here is never rendered as a cause, and the wording the UI and
 * the AI layer are allowed to use is constrained accordingly.
 */
export function correlation(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i] as number; sy += ys[i] as number; }
  const mx = sx / n, my = sy / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = (xs[i] as number) - mx;
    const b = (ys[i] as number) - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Strength label. Deliberately conservative: nothing here is called strong below 0.7. */
export function correlationStrength(r: number): 'negligible' | 'weak' | 'moderate' | 'strong' {
  const a = Math.abs(r);
  if (a < 0.3) return 'negligible';
  if (a < 0.5) return 'weak';
  if (a < 0.7) return 'moderate';
  return 'strong';
}

/**
 * Vocabulary guard.
 *
 * Every sentence the product generates about a contributor passes through
 * here. Causal verbs are not available, by construction, because the data is
 * observational and cannot support them.
 */
export const ASSOCIATION_PHRASES = {
  contribution: (label: string, pct: string) => `${label} accounts for ${pct} of the change`,
  correlation: (label: string, strength: string) => `${label} shows a ${strength} correlation with the change over the same period`,
  coincident: (label: string) => `${label} moved in the same period and may be associated`,
} as const;

const FORBIDDEN_CAUSAL = /\b(caused|causes|causing|because of|due to|resulted in|led to|drove|responsible for)\b/i;

/** Guards generated narrative text. Throws in development rather than shipping a causal claim. */
export function assertNonCausal(sentence: string): string {
  if (FORBIDDEN_CAUSAL.test(sentence)) {
    throw new Error(`Generated narrative makes a causal claim the data cannot support: "${sentence}"`);
  }
  return sentence;
}

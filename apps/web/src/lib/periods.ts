/**
 * Client-safe constants.
 *
 * Deliberately imports nothing. Client components must not reach into
 * @devanalytics/core: that package is server-side and pulls in node:crypto,
 * which cannot be bundled for a browser. Keeping the boundary explicit here is
 * cheaper than discovering it at build time.
 */
export const PERIODS = ['1d', '7d', '30d', '90d', '365d'] as const;
export type PeriodValue = (typeof PERIODS)[number];

export const PERIOD_LABELS: Record<PeriodValue, string> = {
  '1d': 'Today',
  '7d': '7 days',
  '30d': '30 days',
  '90d': '90 days',
  '365d': '1 year',
};

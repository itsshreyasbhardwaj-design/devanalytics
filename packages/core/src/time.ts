/**
 * Time utilities for analytics windows.
 *
 * Every metric in DevAnalytics is defined over a half-open interval [from, to).
 * Half-open intervals are what make daily/weekly/monthly buckets tile the
 * timeline exactly once: a PR merged at exactly midnight belongs to the day
 * that starts at that midnight, and to no other day.
 */

export type Granularity = 'day' | 'week' | 'month';

export type Period = '1d' | '7d' | '30d' | '90d' | '365d';

export interface TimeWindow {
  /** Inclusive lower bound (ISO-8601, UTC). */
  from: string;
  /** Exclusive upper bound (ISO-8601, UTC). */
  to: string;
}

export const PERIOD_DAYS: Record<Period, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '365d': 365,
};

export const MS_PER_DAY = 86_400_000;

export function iso(d: Date | string | number): string {
  return new Date(d).toISOString();
}

export function windowForPeriod(period: Period, now: Date | string = new Date()): TimeWindow {
  const to = new Date(now);
  const from = new Date(to.getTime() - PERIOD_DAYS[period] * MS_PER_DAY);
  return { from: iso(from), to: iso(to) };
}

/**
 * The window of equal length immediately preceding `w`.
 * Used for every "current vs previous" comparison in the product.
 */
export function previousWindow(w: TimeWindow): TimeWindow {
  const from = new Date(w.from).getTime();
  const to = new Date(w.to).getTime();
  const span = to - from;
  return { from: iso(from - span), to: iso(from) };
}

export function windowLengthMs(w: TimeWindow): number {
  return new Date(w.to).getTime() - new Date(w.from).getTime();
}

export function startOfDayUtc(d: Date | string): Date {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

/** ISO week start: Monday 00:00:00 UTC. */
export function startOfWeekUtc(d: Date | string): Date {
  const x = startOfDayUtc(d);
  const dow = (x.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(x.getTime() - dow * MS_PER_DAY);
}

export function startOfMonthUtc(d: Date | string): Date {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1));
}

export function bucketStart(d: Date | string, g: Granularity): Date {
  switch (g) {
    case 'day':
      return startOfDayUtc(d);
    case 'week':
      return startOfWeekUtc(d);
    case 'month':
      return startOfMonthUtc(d);
  }
}

export function nextBucket(d: Date, g: Granularity): Date {
  switch (g) {
    case 'day':
      return new Date(d.getTime() + MS_PER_DAY);
    case 'week':
      return new Date(d.getTime() + 7 * MS_PER_DAY);
    case 'month':
      return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  }
}

/** Every bucket start covering `w`, ascending. Buckets are clipped to the window by callers. */
export function bucketStarts(w: TimeWindow, g: Granularity): string[] {
  const out: string[] = [];
  const end = new Date(w.to).getTime();
  let cur = bucketStart(w.from, g);
  // Guard against pathological inputs producing unbounded loops.
  for (let i = 0; cur.getTime() < end && i < 10_000; i++) {
    out.push(iso(cur));
    cur = nextBucket(cur, g);
  }
  return out;
}

export function hoursBetween(a: Date | string, b: Date | string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}

export function withinWindow(t: Date | string, w: TimeWindow): boolean {
  const ms = new Date(t).getTime();
  return ms >= new Date(w.from).getTime() && ms < new Date(w.to).getTime();
}

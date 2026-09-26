/**
 * GitLab timestamp normalization.
 *
 * GitLab emits at least three timestamp formats across its webhooks, and only
 * one of them is ISO-8601:
 *
 *   "2017-09-20 08:31:45 UTC"        merge request and pipeline attributes
 *   "2021-04-28 21:50:00 +0200"      deployment status_changed_at
 *   "2011-12-12T14:27:31+02:00"      push commit timestamps
 *
 * The canonical event schema requires ISO-8601 with an offset, so every
 * timestamp crossing the adapter boundary passes through here. Getting this
 * wrong is not a parse error — `new Date("2017-09-20 08:31:45 UTC")` is
 * accepted by V8 but silently rejected by other engines, and a naive
 * `.replace(' ', 'T')` would read a +0200 timestamp as UTC and shift every
 * duration metric by two hours.
 */

const SPACED_WITH_ZONE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parse a GitLab timestamp into an ISO-8601 string with an explicit offset.
 * Returns null for anything unrecognised, so callers can decide whether a
 * missing timestamp is fatal rather than inventing "now".
 */
export function parseGitLabTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw.length === 0) return null;

  const match = SPACED_WITH_ZONE.exec(raw);
  if (match) {
    const [, y, mo, d, h, mi, s, frac, zone] = match;
    const millis = frac ? `.${frac.padEnd(3, '0').slice(0, 3)}` : '.000';
    const offset = normalizeZone(zone);
    // Hand the fully-qualified string to Date so the offset is applied rather
    // than assumed.
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${millis}${offset}`;
    const parsed = new Date(iso);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  const fallback = new Date(raw);
  return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
}

function normalizeZone(zone: string | undefined): string {
  // GitLab omits the zone on some fields. Its documented behaviour is UTC, and
  // assuming local time would make every duration wrong by the server's offset.
  if (!zone || zone === 'UTC' || zone === 'Z') return 'Z';
  return zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
}

/** Parse, or fall back to a supplied default (usually the delivery receive time). */
export function parseGitLabTimestampOr(value: unknown, fallback: string): string {
  return parseGitLabTimestamp(value) ?? fallback;
}

/**
 * GitLab reports pipeline queue time as a fractional number of seconds rather
 * than a start timestamp, so CI queue time has to be reconstructed.
 */
export function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

/**
 * Deployment hooks carry only an eight-character `short_sha`, which cannot be
 * matched against a stored 40-character commit sha. The full sha is recoverable
 * from `commit_url`, whose last path segment is the complete hash.
 */
export function fullShaFromCommitUrl(commitUrl: unknown, shortSha: unknown): string {
  const url = typeof commitUrl === 'string' ? commitUrl : '';
  const candidate = url.split(/[/?#]/).filter(Boolean).pop() ?? '';
  if (/^[0-9a-f]{40}$/i.test(candidate)) return candidate.toLowerCase();
  return typeof shortSha === 'string' ? shortSha.toLowerCase() : '';
}

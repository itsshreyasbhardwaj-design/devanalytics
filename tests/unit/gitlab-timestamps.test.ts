import { describe, it, expect } from 'vitest';
import { addSeconds, fullShaFromCommitUrl, parseGitLabTimestamp } from '@devanalytics/gitlab';

describe('GitLab timestamp normalization', () => {
  it('reads the "UTC" form used by merge request and pipeline attributes', () => {
    expect(parseGitLabTimestamp('2017-09-20 08:31:45 UTC')).toBe('2017-09-20T08:31:45.000Z');
  });

  it('applies an explicit offset rather than assuming UTC', () => {
    // The whole point: a naive replace(' ', 'T') would read this as 21:50 UTC
    // and shift every duration derived from it by two hours.
    expect(parseGitLabTimestamp('2021-04-28 21:50:00 +0200')).toBe('2021-04-28T19:50:00.000Z');
    expect(parseGitLabTimestamp('2021-04-28 21:50:00 -0500')).toBe('2021-04-29T02:50:00.000Z');
    expect(parseGitLabTimestamp('2021-04-28 21:50:00 +02:00')).toBe('2021-04-28T19:50:00.000Z');
  });

  it('reads ISO-8601 with an offset, as push commit timestamps use', () => {
    expect(parseGitLabTimestamp('2011-12-12T14:27:31+02:00')).toBe('2011-12-12T12:27:31.000Z');
    expect(parseGitLabTimestamp('2017-09-20T08:31:45.944Z')).toBe('2017-09-20T08:31:45.944Z');
  });

  it('treats a missing zone as UTC, which is what GitLab documents', () => {
    expect(parseGitLabTimestamp('2017-09-20 08:31:45')).toBe('2017-09-20T08:31:45.000Z');
  });

  it('returns null rather than inventing a time', () => {
    for (const bad of [null, undefined, '', '   ', 'yesterday', 42, {}]) {
      expect(parseGitLabTimestamp(bad)).toBeNull();
    }
  });

  it('reconstructs a pipeline start from its queue duration', () => {
    expect(addSeconds('2016-08-12T15:23:28.000Z', 0.01)).toBe('2016-08-12T15:23:28.010Z');
    expect(addSeconds('2016-08-12T15:23:28.000Z', 95)).toBe('2016-08-12T15:25:03.000Z');
  });

  it('recovers a full commit sha from the deployment commit URL', () => {
    const full = '279484c09fbe69ededfced8c1bb6e6d24616b468';
    expect(fullShaFromCommitUrl(`https://gitlab.com/group/proj/-/commit/${full}`, '279484c0')).toBe(full);
    expect(fullShaFromCommitUrl(`https://gitlab.com/group/proj/-/commit/${full.toUpperCase()}`, '279484c0')).toBe(full);
  });

  it('falls back to the short sha when the URL is unusable', () => {
    expect(fullShaFromCommitUrl(null, '279484c0')).toBe('279484c0');
    expect(fullShaFromCommitUrl('https://gitlab.com/group/proj/-/commit/', '279484c0')).toBe('279484c0');
    expect(fullShaFromCommitUrl('not-a-url', '279484C0')).toBe('279484c0');
  });
});

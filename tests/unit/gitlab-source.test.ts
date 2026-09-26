import { describe, it, expect } from 'vitest';
import { GitLabClient, GitLabRateLimitError, GitLabSource, type FetchLike } from '@devanalytics/gitlab';

/**
 * Backfill is exercised against a scripted GitLab instance rather than the
 * network: these tests are about whether the adapter reads GitLab's shapes
 * correctly, which a live call would not tell us any more reliably.
 */
interface Route {
  match: RegExp;
  status?: number;
  headers?: Record<string, string>;
  body: unknown;
}

function fakeGitLab(routes: Route[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const route = routes.find((r) => r.match.test(url) && (!url.includes('/api/graphql') || r.match.source.includes('graphql')));
    if (!route) throw new Error(`no scripted route for ${url}`);
    return {
      ok: (route.status ?? 200) < 400,
      status: route.status ?? 200,
      headers: { get: (name: string) => route.headers?.[name.toLowerCase()] ?? null },
      json: async () => route.body,
      text: async () => JSON.stringify(route.body),
    };
  };
  return { fetchImpl, calls };
}

const PROJECT = {
  id: 15,
  path_with_namespace: 'northwind/payments/checkout',
  default_branch: 'main',
  visibility: 'private',
};

const WINDOW = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };

describe('GitLab backfill', () => {
  it('reads merge requests, including the merged_at the webhook never sends', async () => {
    const { fetchImpl } = fakeGitLab([
      { match: /\/api\/graphql$/, body: { data: { project: { mergeRequests: { nodes: [{ iid: '42', diffStatsSummary: { additions: 120, deletions: 30, fileCount: 6 } }] } } } } },
      { match: /\/projects\/[^/]+\/merge_requests\/42\/notes/, body: [] },
      {
        match: /\/projects\/[^/]+\/merge_requests\?/,
        headers: { 'x-next-page': '' },
        body: [{
          id: 9001, iid: 42, title: 'Add idempotency key', state: 'merged',
          created_at: '2026-03-01 09:00:00 UTC',
          updated_at: '2026-03-01 17:30:00 UTC',
          merged_at: '2026-03-01 17:00:00 UTC',
          closed_at: null,
          target_branch: 'main', source_branch: 'feature/idempotency',
          author: { id: 51, username: 'ana', name: 'Ana Reyes' },
          merge_user: { id: 62, username: 'devon', name: 'Devon Park' },
          merge_commit_sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
          draft: false,
        }],
      },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'northwind/payments', repoFullName: 'northwind/payments/checkout',
      window: WINDOW, cursor: { token: null, done: false }, pageSize: 20,
    });

    expect(page.events.map((e) => e.type)).toEqual(['pull_request.opened', 'pull_request.merged']);
    const merged = page.events[1];
    // The REST merge request reports merged_at directly, so cycle time from
    // backfill is exact rather than accurate-to-webhook-latency.
    expect(merged?.occurredAt).toBe('2026-03-01T17:00:00.000Z');
    expect(merged?.payload).toMatchObject({
      mergedAt: '2026-03-01T17:00:00.000Z',
      createdAt: '2026-03-01T09:00:00.000Z',
      number: 42,
    });
    expect(merged?.actor?.login).toBe('devon');
    expect(page.cursor.done).toBe(true);
  });

  it('fills in diff statistics from GraphQL, which REST does not expose', async () => {
    const { fetchImpl, calls } = fakeGitLab([
      { match: /\/api\/graphql$/, body: { data: { project: { mergeRequests: { nodes: [{ iid: '42', diffStatsSummary: { additions: 120, deletions: 30, fileCount: 6 } }] } } } } },
      { match: /notes/, body: [] },
      { match: /merge_requests\?/, headers: { 'x-next-page': '' }, body: [{ id: 9001, iid: 42, state: 'opened', created_at: '2026-03-01 09:00:00 UTC', target_branch: 'main', source_branch: 'f', author: { id: 1, username: 'ana' } }] },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'northwind/payments', repoFullName: 'northwind/payments/checkout',
      window: WINDOW, cursor: { token: null, done: false }, pageSize: 20,
    });

    expect(page.events[0]?.payload).toMatchObject({ additions: 120, deletions: 30, changedFiles: 6 });
    expect(calls.some((c) => c.startsWith('POST') && c.includes('/api/graphql'))).toBe(true);
  });

  it('leaves sizes unknown when GraphQL is unavailable, rather than reporting zero', async () => {
    const { fetchImpl } = fakeGitLab([
      { match: /\/api\/graphql$/, status: 403, body: { message: 'forbidden' } },
      { match: /notes/, body: [] },
      { match: /merge_requests\?/, headers: { 'x-next-page': '' }, body: [{ id: 9001, iid: 42, state: 'opened', created_at: '2026-03-01 09:00:00 UTC', target_branch: 'main', source_branch: 'f', author: { id: 1, username: 'ana' } }] },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'northwind/payments', repoFullName: 'northwind/payments/checkout',
      window: WINDOW, cursor: { token: null, done: false }, pageSize: 20,
    });

    const payload = page.events[0]?.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('additions');
  });

  it('reconstructs approval timestamps from system notes', async () => {
    const { fetchImpl } = fakeGitLab([
      { match: /\/api\/graphql$/, body: { data: { project: { mergeRequests: { nodes: [] } } } } },
      {
        match: /notes/,
        body: [
          { id: 1, system: true, body: 'assigned to @devon', created_at: '2026-03-01 09:05:00 UTC', author: { id: 51, username: 'ana' } },
          { id: 2, system: true, body: 'approved this merge request', created_at: '2026-03-01 12:00:00 UTC', author: { id: 62, username: 'devon' } },
          { id: 3, system: false, type: 'DiffNote', body: 'needs a retry budget', created_at: '2026-03-01 11:30:00 UTC', author: { id: 62, username: 'devon' }, position: { new_path: 'src/checkout.ts' } },
          { id: 4, system: false, type: null, body: 'looks good overall', created_at: '2026-03-01 11:45:00 UTC', author: { id: 62, username: 'devon' } },
          { id: 5, system: true, body: 'unapproved this merge request', created_at: '2026-03-01 13:00:00 UTC', author: { id: 62, username: 'devon' } },
        ],
      },
      { match: /merge_requests\?/, headers: { 'x-next-page': '' }, body: [{ id: 9001, iid: 42, state: 'opened', created_at: '2026-03-01 09:00:00 UTC', target_branch: 'main', source_branch: 'f', author: { id: 51, username: 'ana' } }] },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'northwind/payments', repoFullName: 'northwind/payments/checkout',
      window: WINDOW, cursor: { token: null, done: false }, pageSize: 20,
    });

    const reviews = page.events.filter((e) => e.type === 'review.submitted');
    expect(reviews).toHaveLength(2);
    expect(reviews[0]).toMatchObject({ occurredAt: '2026-03-01T12:00:00.000Z' });
    expect(reviews[0]?.payload).toMatchObject({ state: 'approved' });
    expect(reviews[1]?.payload).toMatchObject({ state: 'dismissed' });

    // Only the inline diff note is a review comment; the general note and the
    // "assigned to" system note are not review activity.
    const comments = page.events.filter((e) => e.type === 'review_comment.created');
    expect(comments).toHaveLength(1);
    expect(comments[0]?.payload).toMatchObject({ path: 'src/checkout.ts' });
  });

  it('measures pipeline queue time from a real start time', async () => {
    const { fetchImpl } = fakeGitLab([
      {
        match: /\/pipelines\/31$/,
        body: {
          id: 31, sha: 'abc', ref: 'main', source: 'push', status: 'success',
          created_at: '2026-03-01 10:00:00 UTC',
          started_at: '2026-03-01 10:01:30 UTC',
          finished_at: '2026-03-01 10:07:00 UTC',
          user: { id: 51, username: 'ana' },
        },
      },
      { match: /\/pipelines\?/, headers: { 'x-next-page': '' }, body: [{ id: 31 }] },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfillPipelines('northwind/payments', 'northwind/payments/checkout', WINDOW);

    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.payload).toMatchObject({
      conclusion: 'success',
      createdAt: '2026-03-01T10:00:00.000Z',
      // Measured, not reconstructed from a queue duration.
      startedAt: '2026-03-01T10:01:30.000Z',
      completedAt: '2026-03-01T10:07:00.000Z',
    });
  });

  it('prefers a declared environment tier over the environment name', async () => {
    const { fetchImpl } = fakeGitLab([
      { match: /\/environments/, body: [{ name: 'prod-eu-west', tier: 'production' }, { name: 'review-42', tier: 'development' }] },
      {
        match: /\/deployments\?/,
        headers: { 'x-next-page': '' },
        body: [
          { id: 7788, status: 'success', sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7', created_at: '2026-03-01 12:00:00 UTC', updated_at: '2026-03-01 12:05:00 UTC', environment: { name: 'prod-eu-west' }, user: { id: 51, username: 'ana' } },
          { id: 7789, status: 'success', sha: 'bbb', created_at: '2026-03-01 12:30:00 UTC', updated_at: '2026-03-01 12:31:00 UTC', environment: { name: 'review-42' }, user: { id: 51, username: 'ana' } },
        ],
      },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfillDeployments('northwind/payments', 'northwind/payments/checkout', WINDOW);

    expect(page.events).toHaveLength(2);
    // "prod-eu-west" would fail a name regex; the declared tier gets it right.
    expect(page.events[0]?.payload).toMatchObject({ isProduction: true, sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7' });
    // A review app is not production, despite being a successful deployment.
    expect(page.events[1]?.payload).toMatchObject({ isProduction: false });
  });

  it('pages using GitLab pagination headers', async () => {
    const { fetchImpl } = fakeGitLab([
      { match: /\/api\/graphql$/, body: { data: { project: { mergeRequests: { nodes: [] } } } } },
      { match: /notes/, body: [] },
      { match: /merge_requests\?/, headers: { 'x-next-page': '2' }, body: [{ id: 1, iid: 1, state: 'opened', created_at: '2026-03-01 09:00:00 UTC', target_branch: 'main', source_branch: 'f', author: { id: 1, username: 'ana' } }] },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'northwind/payments', repoFullName: 'northwind/payments/checkout',
      window: WINDOW, cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(page.cursor).toEqual({ token: '2', done: false });
  });

  it('URL-encodes the project path, which GitLab requires', async () => {
    const { fetchImpl, calls } = fakeGitLab([
      { match: /\/api\/graphql$/, body: { data: { project: { mergeRequests: { nodes: [] } } } } },
      { match: /merge_requests\?/, headers: { 'x-next-page': '' }, body: [] },
      { match: /\/projects\/[^/]+$/, body: PROJECT },
    ]);

    const source = new GitLabSource(new GitLabClient({ token: 't', fetchImpl }));
    await source.backfill({
      orgSlug: 'northwind/payments', repoFullName: 'northwind/payments/checkout',
      window: WINDOW, cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(calls.some((c) => c.includes('northwind%2Fpayments%2Fcheckout'))).toBe(true);
    expect(calls.some((c) => c.includes('/projects/northwind/payments/checkout'))).toBe(false);
  });

  it('surfaces rate limiting rather than silently returning nothing', async () => {
    const { fetchImpl } = fakeGitLab([
      { match: /./, status: 429, headers: { 'retry-after': '30', 'ratelimit-remaining': '0' }, body: {} },
    ]);
    const client = new GitLabClient({ token: 't', fetchImpl });
    await expect(client.get('/projects/1')).rejects.toThrow(GitLabRateLimitError);
    expect(client.rateLimitRemaining).toBe(0);
  });

  it('targets a self-managed instance when given one', async () => {
    const { fetchImpl, calls } = fakeGitLab([{ match: /\/projects\/[^/]+$/, body: PROJECT }]);
    const source = new GitLabSource(new GitLabClient({ token: 't', baseUrl: 'https://gitlab.internal.example.com/', fetchImpl }));
    await source.projectMeta('northwind/payments/checkout');
    expect(calls[0]).toContain('https://gitlab.internal.example.com/api/v4/projects/');
  });
});

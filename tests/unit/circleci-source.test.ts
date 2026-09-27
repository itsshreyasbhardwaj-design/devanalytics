import { describe, it, expect } from 'vitest';
import { CircleCiClient, CircleCiRateLimitError, CircleCiSource, type FetchLike } from '@devanalytics/circleci';

interface Route { match: RegExp; status?: number; headers?: Record<string, string>; body: unknown }

function fakeCircleCi(routes: Route[]): { fetchImpl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url) => {
    calls.push(url);
    const route = routes.find((r) => r.match.test(url));
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

const WINDOW = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };

const pipeline = (overrides: Record<string, unknown> = {}) => ({
  id: 'pl-1',
  number: 130,
  project_slug: 'gh/acme/api',
  created_at: '2026-03-02T10:00:00Z',
  trigger: { type: 'webhook' },
  vcs: {
    provider_name: 'github',
    target_repository_url: 'https://github.com/acme/api',
    revision: 'abc123',
    branch: 'main',
  },
  ...overrides,
});

describe('CircleCI backfill', () => {
  it('turns pipeline workflows into canonical runs', async () => {
    const { fetchImpl } = fakeCircleCi([
      { match: /\/pipeline\/pl-1\/workflow/, body: { items: [
        { id: 'wf-1', name: 'build-and-test', status: 'success', created_at: '2026-03-02T10:01:00Z', stopped_at: '2026-03-02T10:06:00Z' },
        { id: 'wf-2', name: 'deploy', status: 'failed', created_at: '2026-03-02T10:06:30Z', stopped_at: '2026-03-02T10:08:00Z' },
      ] } },
      { match: /\/project\/[^/]+\/pipeline/, body: { items: [pipeline()], next_page_token: null } },
    ]);

    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });

    expect(page.events).toHaveLength(2);
    expect(page.events[0]?.payload).toMatchObject({
      providerRunId: 'wf-1', conclusion: 'success',
      startedAt: '2026-03-02T10:01:00.000Z', completedAt: '2026-03-02T10:06:00.000Z',
      workflow: { name: 'build-and-test' },
    });
    expect(page.events[1]?.payload).toMatchObject({ conclusion: 'failure', workflow: { name: 'deploy' } });
    expect(page.cursor.done).toBe(true);
  });

  it('points backfilled runs at the code host repository, as a reference', async () => {
    const { fetchImpl } = fakeCircleCi([
      { match: /workflow/, body: { items: [{ id: 'wf-1', name: 'build', status: 'success', created_at: '2026-03-02T10:01:00Z', stopped_at: '2026-03-02T10:06:00Z' }] } },
      { match: /pipeline/, body: { items: [pipeline()], next_page_token: null } },
    ]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(page.events[0]?.repository).toMatchObject({ provider: 'github', fullName: 'acme/api', isReference: true });
  });

  it('reports no enqueue time, exactly as the webhook path does not', async () => {
    const { fetchImpl } = fakeCircleCi([
      { match: /workflow/, body: { items: [{ id: 'wf-1', name: 'build', status: 'success', created_at: '2026-03-02T10:01:00Z', stopped_at: '2026-03-02T10:06:00Z' }] } },
      { match: /pipeline/, body: { items: [pipeline()], next_page_token: null } },
    ]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    // Backfill adds reach, not resolution: CircleCI's API reports no runner
    // wait either, so queue time stays unavailable for CircleCI both ways.
    expect((page.events[0]?.payload as Record<string, unknown>).enqueuedAt).toBeNull();
  });

  it('stops paging once it passes the window', async () => {
    const { fetchImpl } = fakeCircleCi([
      { match: /workflow/, body: { items: [] } },
      { match: /pipeline/, body: { items: [pipeline({ created_at: '2026-01-01T10:00:00Z' })], next_page_token: 'tok-2' } },
    ]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(page.events).toEqual([]);
    expect(page.cursor.done).toBe(true);
  });

  it('carries the page token forward when there is more inside the window', async () => {
    const { fetchImpl, calls } = fakeCircleCi([
      { match: /workflow/, body: { items: [] } },
      { match: /pipeline/, body: { items: [pipeline()], next_page_token: 'tok-2' } },
    ]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    const first = await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(first.cursor).toEqual({ token: 'tok-2', done: false });

    await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: first.cursor, pageSize: 20,
    });
    expect(calls.some((c) => c.includes('page-token=tok-2'))).toBe(true);
  });

  it('skips a pipeline on a host this platform does not model', async () => {
    const { fetchImpl } = fakeCircleCi([
      { match: /workflow/, body: { items: [{ id: 'wf-1', name: 'build', status: 'success', created_at: '2026-03-02T10:01:00Z', stopped_at: '2026-03-02T10:06:00Z' }] } },
      { match: /pipeline/, body: { items: [pipeline({
        project_slug: 'bb/acme/api',
        vcs: { provider_name: 'bitbucket', target_repository_url: 'https://bitbucket.org/acme/api', revision: 'abc', branch: 'main' },
      })], next_page_token: null } },
    ]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    const page = await source.backfill({
      orgSlug: 'acme', repoFullName: 'bb/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(page.events).toEqual([]);
  });

  it('URL-encodes the project slug', async () => {
    const { fetchImpl, calls } = fakeCircleCi([
      { match: /workflow/, body: { items: [] } },
      { match: /pipeline/, body: { items: [], next_page_token: null } },
    ]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', fetchImpl }));
    await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(calls[0]).toContain('gh%2Facme%2Fapi');
  });

  it('surfaces rate limiting rather than returning nothing', async () => {
    const { fetchImpl } = fakeCircleCi([
      { match: /./, status: 429, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0' }, body: {} },
    ]);
    const client = new CircleCiClient({ token: 't', fetchImpl });
    await expect(client.get('/project/x/pipeline')).rejects.toThrow(CircleCiRateLimitError);
    expect(client.rateLimitRemaining).toBe(0);
  });

  it('targets a self-hosted CircleCI server when given one', async () => {
    const { fetchImpl, calls } = fakeCircleCi([{ match: /pipeline/, body: { items: [], next_page_token: null } }]);
    const source = new CircleCiSource(new CircleCiClient({ token: 't', baseUrl: 'https://circleci.internal.example.com/', fetchImpl }));
    await source.backfill({
      orgSlug: 'acme', repoFullName: 'gh/acme/api', window: WINDOW,
      cursor: { token: null, done: false }, pageSize: 20,
    });
    expect(calls[0]).toContain('https://circleci.internal.example.com/api/v2/project/');
  });
});

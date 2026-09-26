import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@devanalytics/db';
import { loadFixture, FIXTURE_WINDOW, type FixtureIds } from '@devanalytics/demo-data';
import { DevAnalyticsError } from '@devanalytics/sdk';
import { testDatabase } from '../helpers/db.js';
import { createTestApi, issueToken, sdkFor, type TestApi } from '../helpers/api.js';

describe('REST API and SDK', () => {
  let db: Database;
  let api: TestApi;
  let ids: FixtureIds;
  let ownerToken: string;
  let viewerToken: string;

  beforeAll(async () => {
    db = await testDatabase();
    ids = await loadFixture(db);
    api = createTestApi(db);
    ownerToken = await issueToken(db, ids.orgId, 'owner', 'owner');
    viewerToken = await issueToken(db, ids.orgId, 'viewer', 'viewer');
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const window = { from: FIXTURE_WINDOW.from, to: FIXTURE_WINDOW.to };

  it('serves health without credentials', async () => {
    const res = await api.handle(new Request('http://api.test/api/v1/health'));
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe('ok');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await api.handle(new Request('http://api.test/api/v1/repositories'));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe('unauthorized');
  });

  it('rejects a forged token', async () => {
    const res = await api.handle(
      new Request('http://api.test/api/v1/repositories', { headers: { authorization: 'Bearer dva_deadbeef_forged' } }),
    );
    expect(res.status).toBe(401);
  });

  it('returns a 404 with a useful message for an unknown route', async () => {
    const res = await api.handle(new Request('http://api.test/api/v1/nope'));
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toMatch(/No route for GET/);
  });

  it('exposes every metric definition through the SDK', async () => {
    const sdk = sdkFor(api, ownerToken);
    const { metrics } = await sdk.metrics.list();
    // Fourteen documented metrics plus the mean variant of cycle time.
    expect(metrics.length).toBe(15);
    for (const m of metrics) {
      expect(m.formula.length).toBeGreaterThan(10);
      expect(m.dataSource.length).toBeGreaterThan(0);
      expect(m.timeAnchor.length).toBeGreaterThan(0);
      expect(m.minimumSampleSize).toBeGreaterThan(0);
      expect(m.caveats.length).toBeGreaterThan(0);
    }
  });

  it('returns the same metric value over HTTP as the engine computes directly', async () => {
    const sdk = sdkFor(api, ownerToken);
    const viaHttp = await sdk.metrics.get('pr_cycle_time', window);
    const direct = await api.engine.value({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
    });
    expect(viaHttp.result).toEqual(direct.result);
    if (viaHttp.result.status === 'ok') expect(viaHttp.result.value).toBeCloseTo(8, 6);
  });

  it('preserves insufficient_data across the wire instead of coercing to zero', async () => {
    const sdk = sdkFor(api, ownerToken);
    const value = await sdk.metrics.get('reopened_pr_rate', window);
    expect(value.result.status).toBe('insufficient_data');
    if (value.result.status === 'insufficient_data') {
      expect(value.result.sampleSize).toBe(6);
      expect(value.result.minimumSampleSize).toBe(20);
      expect(value.result.reason).toBe('below_minimum_sample');
    }
    const raw = await api.handle(
      new Request(`http://api.test/api/v1/metrics/reopened_pr_rate/value?from=${window.from}&to=${window.to}`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    const body = await raw.json();
    expect(body.data.result.value).toBeUndefined();
  });

  it('reports exclusions alongside a value', async () => {
    const sdk = sdkFor(api, ownerToken);
    const value = await sdk.metrics.get('lead_time_for_changes', window);
    expect(value.excluded?.count).toBe(5);
  });

  it('serves series, comparison, breakdown and facts', async () => {
    const sdk = sdkFor(api, ownerToken);
    const series = await sdk.metrics.series('pr_cycle_time', { ...window, granularity: 'day' });
    expect(series.points.length).toBe(5);
    expect(series.granularity).toBe('day');

    const comparison = await sdk.metrics.compare('pr_cycle_time', window);
    expect(comparison.current.result.status).toBe('ok');
    expect(comparison.previousWindow.to).toBe(window.from);

    const breakdown = await sdk.metrics.breakdown('pr_cycle_time', 'author', window);
    expect(breakdown.rows.map((r) => r.label).sort()).toEqual(['alice', 'bob', 'carol']);

    const facts = await sdk.metrics.facts('pr_cycle_time', window);
    expect(facts.facts.length).toBe(5);
  });

  it('validates query parameters instead of guessing', async () => {
    const headers = { authorization: `Bearer ${ownerToken}` };
    const bad = [
      '/api/v1/metrics/pr_cycle_time/value?period=99d',
      '/api/v1/metrics/pr_cycle_time/value?scopeType=nonsense',
      '/api/v1/metrics/pr_cycle_time/value?scopeType=repository',
      '/api/v1/metrics/pr_cycle_time/value?from=2026-03-01T00:00:00Z',
      '/api/v1/metrics/pr_cycle_time/value?from=2026-03-08T00:00:00Z&to=2026-03-01T00:00:00Z',
      '/api/v1/metrics/pr_cycle_time/series?granularity=fortnight',
      '/api/v1/metrics/pr_cycle_time/breakdown?dimension=zodiac',
      '/api/v1/metrics/pr_cycle_time/value?excludeBots=maybe',
    ];
    for (const path of bad) {
      const res = await api.handle(new Request(`http://api.test${path}`, { headers }));
      expect(res.status, path).toBe(400);
      expect((await res.json()).error.code).toBe('invalid_request');
    }
  });

  it('rejects an unknown metric rather than returning an empty result', async () => {
    const sdk = sdkFor(api, ownerToken);
    await expect(sdk.metrics.get('vibes', window)).rejects.toThrow(DevAnalyticsError);
  });

  it('enforces RBAC: a viewer cannot create an investigation', async () => {
    const viewer = sdkFor(api, viewerToken);
    await expect(viewer.investigations.create({ metric: 'pr_cycle_time' })).rejects.toMatchObject({ status: 403 });

    const owner = sdkFor(api, ownerToken);
    const report = (await owner.investigations.create({ metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId }, window)) as { id: string };
    expect(report.id).toBeTypeOf('string');
  });

  it('enforces RBAC: a viewer cannot export data or run admin actions', async () => {
    const viewer = sdkFor(api, viewerToken);
    for (const path of ['/api/v1/export/metrics/pr_cycle_time', '/api/v1/admin/snapshots/refresh', '/api/v1/anomalies/detect']) {
      const res = await api.handle(
        new Request(`http://api.test${path}`, { method: path.includes('export') ? 'GET' : 'POST', headers: { authorization: `Bearer ${viewerToken}` } }),
      );
      expect(res.status, path).toBe(403);
    }
    void viewer;
  });

  it('serves repository health as named metrics, not a single score', async () => {
    const sdk = sdkFor(api, ownerToken);
    const health = (await sdk.repositories.health(ids.repoId, window)) as {
      fullName: string; metrics: { metric: string; value: string; sampleSize: number }[]; recentAnomalies: unknown[];
    };
    expect(health.fullName).toBe('fixture-co/app');
    expect(health.metrics.length).toBeGreaterThan(5);
    expect(health).not.toHaveProperty('score');
    expect(health).not.toHaveProperty('grade');
    const cycle = health.metrics.find((m) => m.metric === 'pr_cycle_time');
    expect(cycle?.value).toBe('8.0 h');
  });

  it('serves a pull request timeline in order', async () => {
    const sdk = sdkFor(api, ownerToken);
    const { pullRequests } = await sdk.pullRequests.list({ limit: 10 });
    expect(pullRequests.length).toBeGreaterThan(0);
    const first = pullRequests.find((p) => p.number === 1);
    const detail = (await sdk.pullRequests.get(first?.id as string)) as {
      timeline: { at: string; kind: string }[]; durations: { cycleTimeHours: number | null }; reviewers: unknown[];
    };
    expect(detail.durations.cycleTimeHours).toBeCloseTo(4, 3);
    expect(detail.reviewers.length).toBe(2);
    const times = detail.timeline.map((t) => t.at);
    expect([...times].sort()).toEqual(times);
    // The earliest entry is a commit authored before the PR was opened, which is
    // exactly why lead time and cycle time measure from different anchors.
    expect(detail.timeline[0]?.kind).toBe('commit');
    expect(detail.timeline.map((t) => t.kind)).toContain('ready_for_review');
    // The production deployment lands an hour after the merge, so it is last.
    expect(detail.timeline.at(-1)?.kind).toBe('deployment');
    const kinds = detail.timeline.map((t) => t.kind);
    expect(kinds.indexOf('merged')).toBeLessThan(kinds.indexOf('deployment'));
  });

  it('exports CSV with the metric definition and window embedded', async () => {
    const res = await api.handle(
      new Request(`http://api.test/api/v1/export/metrics/pr_cycle_time?from=${window.from}&to=${window.to}&granularity=day`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    const csv = await res.text();
    expect(csv).toMatch(/# metric,pr_cycle_time/);
    expect(csv).toMatch(/# minimum_sample_size,5/);
    expect(csv).toMatch(/# DATA SOURCE,SYNTHETIC DEMO DATA/);
    expect(csv).toMatch(/bucket_start,value,formatted,sample_size/);
    // Daily buckets have one PR each, below the minimum.
    expect(csv).toMatch(/Insufficient data/);
  });

  it('exports JSON carrying the metric contract', async () => {
    const res = await api.handle(
      new Request(`http://api.test/api/v1/export/metrics/pr_cycle_time?from=${window.from}&to=${window.to}&format=json`, {
        headers: { authorization: `Bearer ${ownerToken}` },
      }),
    );
    const body = await res.json();
    expect(body.metric.id).toBe('pr_cycle_time');
    expect(body.metric.caveats.length).toBeGreaterThan(0);
    expect(body.dataSource).toBe('synthetic_demo');
    expect(body.points.every((p: { status: string }) => ['ok', 'insufficient_data'].includes(p.status))).toBe(true);
  });

  it('exports an investigation as Markdown and as a valid PDF', async () => {
    const owner = sdkFor(api, ownerToken);
    const report = (await owner.investigations.create({ metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId }, window)) as { id: string };

    const md = await api.handle(
      new Request(`http://api.test/api/v1/export/investigations/${report.id}`, { headers: { authorization: `Bearer ${ownerToken}` } }),
    );
    const markdown = await md.text();
    expect(markdown).toMatch(/^> \*\*Synthetic demo data\.\*\*/);
    expect(markdown).toMatch(/# PR cycle time/);
    expect(markdown).toMatch(/## How to read this/);
    // The fixture has no data before its window, so the report says there is no
    // baseline rather than decomposing against an empty period.
    expect(markdown).toMatch(/no comparable baseline period/);

    const pdf = await api.handle(
      new Request(`http://api.test/api/v1/export/investigations/${report.id}?format=pdf`, { headers: { authorization: `Bearer ${ownerToken}` } }),
    );
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(text).toMatch(/\/Type \/Catalog/);
    // xref offset must point at the xref table for the file to be readable.
    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    expect(text.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('publishes an OpenAPI document covering every route', async () => {
    const res = await api.handle(new Request('http://api.test/api/v1/openapi.json'));
    const doc = (await res.json()).data;
    expect(doc.openapi).toBe('3.1.0');
    const paths = Object.keys(doc.paths);
    expect(paths).toContain('/api/v1/metrics/{metric}/value');
    expect(paths).toContain('/api/v1/ai/query');
    expect(paths).toContain('/api/v1/webhooks/{provider}/{endpointId}');
    expect(paths.length).toBeGreaterThan(20);
  });

  it('answers an AI query over HTTP with citations', async () => {
    const sdk = sdkFor(api, ownerToken);
    const answer = await sdk.ai.query('What is our PR cycle time?');
    expect(answer.plan.metric).toBe('pr_cycle_time');
    expect(answer.plan.intent).toBe('metric_value');
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.generatedBy).toBe('deterministic');
    expect(answer.grounding.grounded).toBe(true);
  });

  it('rate limits a hot caller and reports retry-after', async () => {
    const headers = { authorization: `Bearer ${ownerToken}` };
    let limited: Response | null = null;
    for (let i = 0; i < 200; i++) {
      const res = await api.handle(new Request('http://api.test/api/v1/repositories', { headers }));
      if (res.status === 429) { limited = res; break; }
    }
    expect(limited).not.toBeNull();
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await (limited as Response).json()).error.code).toBe('rate_limited');
  });
});

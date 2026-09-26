import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@devanalytics/db';
import { buildTools, findMutatingTools } from '@devanalytics/mcp';
import { loadFixture, type FixtureIds } from '@devanalytics/demo-data';
import { testDatabase } from '../helpers/db.js';
import { createTestApi, issueToken, sdkFor, type TestApi } from '../helpers/api.js';

describe('MCP server', () => {
  let db: Database;
  let api: TestApi;
  let ids: FixtureIds;
  let tools: ReturnType<typeof buildTools>;
  let viewerTools: ReturnType<typeof buildTools>;

  beforeAll(async () => {
    db = await testDatabase();
    ids = await loadFixture(db);
    api = createTestApi(db);
    tools = buildTools(sdkFor(api, await issueToken(db, ids.orgId, 'member', 'mcp-member')));
    viewerTools = buildTools(sdkFor(api, await issueToken(db, ids.orgId, 'viewer', 'mcp-viewer')));
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const call = (set: typeof tools, name: string, args: Record<string, unknown> = {}) => {
    const tool = set.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.handler(args);
  };

  const window = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };

  it('exposes no mutating tool', () => {
    expect(findMutatingTools(tools)).toEqual([]);
    const names = tools.map((t) => t.name);
    for (const forbidden of ['run_sql', 'execute_sql', 'acknowledge_anomaly', 'create_investigation', 'connect_repository', 'refresh_snapshots']) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('documents every tool and validates its input', () => {
    expect(tools.length).toBeGreaterThan(12);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.schema.safeParse({}).success || Object.keys(tool.schema.shape).length > 0).toBe(true);
    }
  });

  it('tells an agent which metrics exist before it can ask for one', async () => {
    const result = (await call(tools, 'list_metrics')) as { metrics: { id: string; formula: string; minimumSampleSize: number }[] };
    expect(result.metrics.length).toBe(15);
    expect(result.metrics.every((m) => m.formula.length > 0 && m.minimumSampleSize > 0)).toBe(true);
  });

  it('returns metric values with sample sizes intact', async () => {
    const value = (await call(tools, 'get_metric', { metric: 'pr_cycle_time', ...window })) as {
      result: { status: string; value?: number; sampleSize: number };
    };
    expect(value.result.status).toBe('ok');
    expect(value.result.value).toBeCloseTo(8, 6);
    expect(value.result.sampleSize).toBe(5);
  });

  it('surfaces insufficient_data rather than a zero an agent would average', async () => {
    const value = (await call(tools, 'get_metric', { metric: 'reopened_pr_rate', ...window })) as {
      result: { status: string; sampleSize: number; minimumSampleSize: number };
    };
    expect(value.result.status).toBe('insufficient_data');
    expect(value.result.minimumSampleSize).toBe(20);
    expect(value.result).not.toHaveProperty('value');
  });

  it('groups PR, CI and deployment metrics for one round trip', async () => {
    const pr = (await call(tools, 'get_pr_metrics', window)) as { metrics: { metric: string }[] };
    expect(pr.metrics.map((m) => m.metric)).toContain('pr_cycle_time');
    const ci = (await call(tools, 'get_ci_metrics', window)) as { metrics: { metric: string }[] };
    expect(ci.metrics.map((m) => m.metric)).toEqual(['build_success_rate', 'build_duration', 'ci_queue_time']);
    const deploy = (await call(tools, 'get_deployment_metrics', window)) as { metrics: { metric: string }[] };
    expect(deploy.metrics.map((m) => m.metric)).toContain('lead_time_for_changes');
  });

  it('serves repository health without a composite score', async () => {
    const health = (await call(tools, 'get_repository_metrics', { repositoryId: ids.repoId, ...window })) as {
      metrics: unknown[]; fullName: string;
    };
    expect(health.fullName).toBe('fixture-co/app');
    expect(health.metrics.length).toBeGreaterThan(5);
    expect(health).not.toHaveProperty('score');
  });

  it('lets an agent trace a metric back to raw events', async () => {
    const events = (await call(tools, 'search_engineering_events', { limit: 5 })) as { events: unknown[] };
    expect(Array.isArray(events.events)).toBe(true);
    const prs = (await call(tools, 'list_pull_requests', { limit: 5 })) as { pullRequests: { id: string }[] };
    expect(prs.pullRequests.length).toBeGreaterThan(0);
    const detail = (await call(tools, 'get_pull_request', { pullRequestId: prs.pullRequests[0]?.id })) as { timeline: unknown[] };
    expect(detail.timeline.length).toBeGreaterThan(0);
  });

  it('answers a question with citations', async () => {
    const answer = (await call(tools, 'ask_devanalytics', { question: 'What is our PR cycle time?' })) as {
      citations: unknown[]; grounding: { grounded: boolean };
    };
    expect(answer.citations.length).toBeGreaterThan(0);
    expect(answer.grounding.grounded).toBe(true);
  });

  it('works with a viewer-role token, so the credential itself cannot write', async () => {
    const value = (await call(viewerTools, 'get_metric', { metric: 'pr_cycle_time', ...window })) as { result: { status: string } };
    expect(value.result.status).toBe('ok');
    // A viewer cannot create investigations even through the underlying API.
    const sdk = sdkFor(api, await issueToken(db, ids.orgId, 'viewer', 'mcp-viewer-2'));
    await expect(sdk.investigations.create({ metric: 'pr_cycle_time' })).rejects.toMatchObject({ status: 403 });
  });

  it('reports a tool failure as an error rather than an empty result', async () => {
    await expect(call(tools, 'get_metric', { metric: 'not_a_metric', ...window })).rejects.toThrow();
  });
});

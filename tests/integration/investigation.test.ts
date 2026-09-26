import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@devanalytics/db';
import { MetricEngine } from '@devanalytics/metrics';
import { Investigator, runDetection, persistDetections } from '@devanalytics/investigations';
import { DEFAULT_SCENARIO, generateDemoOrganization, type GenerateResult } from '@devanalytics/demo-data';
import { MS_PER_DAY } from '@devanalytics/core';
import { testDatabase } from '../helpers/db.js';

/**
 * End-to-end check of change intelligence against a dataset with a known,
 * deliberately planted regression. The test asserts the system finds the
 * planted cause and does not invent others.
 */
describe('change intelligence on the demo scenario', () => {
  let db: Database;
  let engine: MetricEngine;
  let demo: GenerateResult;
  let window: { from: string; to: string };
  let baselineWindow: { from: string; to: string };

  beforeAll(async () => {
    db = await testDatabase();
    demo = await generateDemoOrganization(db, { days: 120, seed: 7 });
    engine = new MetricEngine(db);
    const end = new Date(demo.windowEnd);
    // The window under test sits inside the planted regression and stops four
    // days short of the data's end: a pull request opened on the last day has
    // not merged yet, so including the trailing days would silently drop the
    // slowest PRs and understate the very regression we are measuring.
    window = {
      from: new Date(end.getTime() - 25 * MS_PER_DAY).toISOString(),
      to: new Date(end.getTime() - 4 * MS_PER_DAY).toISOString(),
    };
    baselineWindow = {
      from: new Date(end.getTime() - 70 * MS_PER_DAY).toISOString(),
      to: new Date(end.getTime() - 28 * MS_PER_DAY).toISOString(),
    };
  }, 300_000);

  afterAll(async () => {
    await db.close();
  });

  it('generates a substantial, clearly-labelled demo organization', async () => {
    expect(demo.counts.pullRequests).toBeGreaterThan(500);
    expect(demo.counts.reviews).toBeGreaterThan(500);
    expect(demo.counts.workflowRuns).toBeGreaterThan(500);
    expect(demo.counts.deployments).toBeGreaterThan(20);
    const isDemo = await db.withOrg(demo.orgId, (sql) => sql.value<boolean>(`select is_demo from organizations where id = $1`, [demo.orgId]));
    expect(isDemo).toBe(true);
  });

  it('measures the planted cycle time regression against a pre-regression baseline', async () => {
    const base = { orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org' as const, scopeId: demo.orgId };
    const current = await engine.value({ ...base, window });
    const baseline = await engine.value({ ...base, window: baselineWindow });
    expect(current.result.status).toBe('ok');
    expect(baseline.result.status).toBe('ok');
    if (current.result.status !== 'ok' || baseline.result.status !== 'ok') return;
    expect(current.result.value / baseline.result.value).toBeGreaterThan(1.25);
  });

  it('shows no movement when both windows sit inside the regression', async () => {
    // A rolling "vs previous period" comparison cannot see a level shift that
    // began before the previous period. This is a property of the comparison,
    // not a bug, and the investigation view exposes the baseline window for
    // exactly this reason.
    const end = new Date(demo.windowEnd);
    const insideRegression = {
      from: new Date(end.getTime() - 14 * MS_PER_DAY).toISOString(),
      to: new Date(end.getTime() - 4 * MS_PER_DAY).toISOString(),
    };
    const { comparison } = await engine.comparison({
      orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: demo.orgId, window: insideRegression,
    });
    expect(Math.abs(comparison.relativeChange ?? 0)).toBeLessThan(0.25);
  });

  it('attributes the movement to the repository the regression was planted in', async () => {
    const investigator = new Investigator(db, engine);
    const report = await investigator.investigate({
      orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: demo.orgId, window, baselineWindow,
    });

    const repoFinding = report.dimensions.find((d) => d.dimension === 'repository');
    expect(repoFinding).toBeDefined();
    expect(repoFinding?.residual).toBeCloseTo(0, 6);

    const top = repoFinding?.contributors[0];
    expect(top?.label).toBe(DEFAULT_SCENARIO.repository);
    expect(top?.contributionShare as number).toBeGreaterThan(0.5);
    expect(top?.statement).toMatch(/accounts for/);
    // The story is that this repository got slower, not that it grew.
    expect(Math.abs(top?.rateEffect as number)).toBeGreaterThan(Math.abs(top?.mixEffect as number));
    expect(top?.statement).toMatch(/its own values changing/);
  });

  it('identifies review latency and PR size as associated, without claiming cause', async () => {
    const investigator = new Investigator(db, engine);
    const report = await investigator.investigate({
      orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: demo.orgId, window, baselineWindow,
    });

    const byMetric = new Map(report.related.map((r) => [r.metric, r]));
    expect(byMetric.get('time_to_first_review')?.moved).toBe(true);
    expect((byMetric.get('time_to_first_review')?.comparison.relativeChange ?? 0) > 0).toBe(true);
    expect(byMetric.get('pr_size')?.moved).toBe(true);

    // Every generated sentence is associative.
    const sentences = [report.headline, ...report.related.map((r) => r.statement), ...report.dimensions.flatMap((d) => d.contributors.map((c) => c.statement))];
    for (const s of sentences) {
      expect(s).not.toMatch(/\b(caused|because of|due to|led to|resulted in)\b/i);
    }
  });

  it('reports candidate metrics that did not move, instead of hiding them', async () => {
    const investigator = new Investigator(db, engine);
    const report = await investigator.investigate({
      orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: demo.orgId, window, baselineWindow,
    });
    const unchanged = report.related.filter((r) => !r.moved);
    expect(unchanged.length).toBeGreaterThan(0);
    expect(unchanged.every((r) => r.statement.length > 0)).toBe(true);
  });

  it('links back to the individual pull requests behind the change', async () => {
    const investigator = new Investigator(db, engine);
    const report = await investigator.investigate({
      orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: demo.orgId, window, baselineWindow,
    });
    expect(report.evidence.length).toBeGreaterThan(0);
    const first = report.evidence[0];
    expect(first?.kind).toBe('pull_request');
    expect(first?.url).toMatch(/^\/pull-requests\//);
    expect(first?.detail.cycleTimeHours).toBeTypeOf('number');
  });

  it('persists an investigation and its findings', async () => {
    const investigator = new Investigator(db, engine);
    const report = await investigator.investigate({
      orgId: demo.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: demo.orgId, window, baselineWindow,
    });
    const id = await investigator.save(report, null);
    const findings = await db.withOrg(demo.orgId, (sql) =>
      sql.many<{ dimension: string; label: string }>(`select dimension, label from investigation_findings where investigation_id = $1 order by rank`, [id]),
    );
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.map((f) => f.dimension)).toContain('repository');
  });

  it('runs detection across scopes and only records real anomalies', async () => {
    const detections = await runDetection(db, engine, {
      orgId: demo.orgId,
      scopes: [{ scopeType: 'org', scopeId: demo.orgId }],
      metrics: ['pr_cycle_time', 'time_to_first_review', 'ci_queue_time', 'build_success_rate'],
      granularity: 'week',
      asOf: new Date(demo.windowEnd),
      baselineBuckets: 14,
    });
    expect(detections.length).toBeGreaterThan(0);
    // Every detection, positive or not, carries its sample sizes and a reason.
    for (const d of detections) {
      expect(d.sampleSize).toBeTypeOf('number');
      expect(d.baselineSampleSize).toBeTypeOf('number');
      expect(d.explanation.length).toBeGreaterThan(10);
      if (!d.isAnomaly) expect(d.reason).toBeDefined();
    }
    const saved = await persistDetections(db, demo.orgId, detections);
    const stored = await db.withOrg(demo.orgId, (sql) => sql.many(`select id from anomalies`));
    expect(stored.length).toBe(saved);
  });
});

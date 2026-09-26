import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Database } from '@devanalytics/db';
import { MetricEngine, METRIC_IDS, requireMetricDefinition } from '@devanalytics/metrics';
import { FIXTURE_EXPECTATIONS, FIXTURE_WINDOW, loadFixture, type FixtureIds } from '@devanalytics/demo-data';
import { testDatabase } from '../helpers/db.js';

/**
 * The metric engine is checked against values derived by hand from the fixture
 * table, not against its own previous output.
 */
describe('metric engine against the deterministic fixture', () => {
  let db: Database;
  let engine: MetricEngine;
  let ids: FixtureIds;

  beforeAll(async () => {
    db = await testDatabase();
    ids = await loadFixture(db);
    engine = new MetricEngine(db);
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it('has an expectation for every registered metric', () => {
    expect(Object.keys(FIXTURE_EXPECTATIONS).sort()).toEqual([...METRIC_IDS].sort());
  });

  for (const [metric, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
    it(`computes ${metric} (${expected.derivation})`, async () => {
      const out = await engine.value({
        orgId: ids.orgId, metric, scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
      });
      expect(out.result.status, `${metric} status`).toBe(expected.status);
      expect(out.result.sampleSize, `${metric} sample size`).toBe(expected.sampleSize);
      if (out.result.status === 'ok' && expected.value !== null) {
        expect(out.result.value, `${metric} value`).toBeCloseTo(expected.value, 6);
      }
    });
  }

  it('reports what lead time excluded rather than silently dropping it', async () => {
    const out = await engine.value({
      orgId: ids.orgId, metric: 'lead_time_for_changes', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
    });
    expect(out.excluded?.count).toBe(5);
    expect(out.excluded?.reason).toMatch(/no linked pull request/i);
  });

  it('returns insufficient_data rather than a number below the minimum sample', async () => {
    const out = await engine.value({
      orgId: ids.orgId, metric: 'reopened_pr_rate', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
    });
    expect(out.result).toEqual({
      status: 'insufficient_data',
      reason: 'below_minimum_sample',
      sampleSize: 6,
      minimumSampleSize: requireMetricDefinition('reopened_pr_rate').minimumSampleSize,
    });
  });

  it('refuses scopes a metric does not support', async () => {
    const out = await engine.value({
      orgId: ids.orgId, metric: 'build_success_rate', scopeType: 'developer',
      scopeId: ids.userIds.alice as string, window: FIXTURE_WINDOW,
    });
    expect(out.result).toMatchObject({ status: 'insufficient_data', reason: 'metric_not_supported_for_scope' });
  });

  it('keeps bot-authored pull requests out of the default view but can include them', async () => {
    const withoutBots = await engine.value({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
    });
    const withBots = await engine.value({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId,
      window: FIXTURE_WINDOW, filters: { excludeBots: false },
    });
    expect(withoutBots.result.sampleSize).toBe(5);
    // Including the bot PR (merged in 1h) makes the set [1,4,6,8,10,20]; median = 7.
    expect(withBots.result.sampleSize).toBe(6);
    if (withBots.result.status === 'ok') expect(withBots.result.value).toBeCloseTo(7, 6);
  });

  it('scopes to a single repository identically to the org when only one repo exists', async () => {
    const orgLevel = await engine.value({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
    });
    const repoLevel = await engine.value({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'repository', scopeId: ids.repoId, window: FIXTURE_WINDOW,
    });
    expect(repoLevel.result).toEqual(orgLevel.result);
  });

  it('buckets a time series without double counting', async () => {
    const series = await engine.series({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId,
      window: FIXTURE_WINDOW, granularity: 'day',
    });
    // One merged non-bot PR per day on days 1-5.
    expect(series).toHaveLength(5);
    const total = series.reduce((a, p) => a + p.result.sampleSize, 0);
    expect(total).toBe(5);
    // Daily buckets have a single observation each, below the metric minimum.
    expect(series.every((p) => p.result.status === 'insufficient_data')).toBe(true);
  });

  it('breaks a metric down by author without ranking people', async () => {
    const rows = await engine.breakdown(
      { orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW },
      'author',
    );
    const labels = rows.map((r) => r.label).sort();
    expect(labels).toEqual(['alice', 'bob', 'carol']);
    expect(rows.reduce((a, r) => a + r.result.sampleSize, 0)).toBe(5);
  });

  it('compares against the immediately preceding window', async () => {
    const { current, previous, comparison } = await engine.comparison({
      orgId: ids.orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: ids.orgId, window: FIXTURE_WINDOW,
    });
    expect(current.result.status).toBe('ok');
    // Nothing exists before the fixture window.
    expect(previous.result).toMatchObject({ status: 'insufficient_data', reason: 'no_data' });
    expect(comparison.relativeChange).toBeNull();
    expect(comparison.direction).toBe('unknown');
  });
});

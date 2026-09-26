/**
 * Benchmarks.
 *
 * Methodology, stated so the numbers can be judged:
 *
 * - Every run builds a fresh in-memory Postgres 16 (PGlite) and seeds the same
 *   deterministic demo organization, so runs are comparable to each other.
 * - The embedded engine is a single connection with no network hop. Managed
 *   Postgres will differ: expect higher per-query latency and much better
 *   parallelism. These numbers measure the engine's *work*, not a deployment.
 * - Each measurement is preceded by warmup iterations that are discarded, then
 *   reports p50/p95/max over the measured iterations, not a mean.
 * - No caching layer is enabled. Dashboard queries here read raw rows; a
 *   deployment serving from metric snapshots will be faster.
 *
 *   pnpm bench
 */
import { MS_PER_DAY, type Granularity } from '@devanalytics/core';
import { Database, type ScopedSql } from '@devanalytics/db';
import { MetricEngine, METRIC_IDS, refreshSnapshots } from '@devanalytics/metrics';
import { Investigator, runDetection } from '@devanalytics/investigations';
import { EventWorker, IngestionService, PostgresJobQueue } from '@devanalytics/event-ingestion';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { generateDemoOrganization } from '@devanalytics/demo-data';
import { createHmac } from 'node:crypto';

interface Sample {
  name: string;
  unit: 'ms' | 'ops/s';
  p50: number;
  p95: number;
  max: number;
  iterations: number;
  note?: string;
}

const results: Sample[] = [];

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? (sorted[lo] as number) : (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

async function measure(name: string, iterations: number, warmup: number, fn: (i: number) => Promise<unknown>, note?: string): Promise<void> {
  for (let i = 0; i < warmup; i++) await fn(i);
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await fn(i);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const sample: Sample = {
    name, unit: 'ms',
    p50: quantile(times, 0.5), p95: quantile(times, 0.95), max: times[times.length - 1] as number,
    iterations,
  };
  if (note) sample.note = note;
  results.push(sample);
  process.stdout.write(`  ${name.padEnd(46)} p50 ${sample.p50.toFixed(1).padStart(8)} ms   p95 ${sample.p95.toFixed(1).padStart(8)} ms\n`);
}

function throughput(name: string, count: number, elapsedMs: number, note?: string): void {
  const ops = (count / elapsedMs) * 1000;
  const sample: Sample = { name, unit: 'ops/s', p50: ops, p95: ops, max: ops, iterations: count };
  if (note) sample.note = note;
  results.push(sample);
  process.stdout.write(`  ${name.padEnd(46)} ${ops.toFixed(0).padStart(8)} ops/s  (${count} in ${elapsedMs.toFixed(0)} ms)\n`);
}

const days = Number(process.env.BENCH_DAYS ?? 180);
process.stdout.write(`DevAnalytics benchmarks\n  node ${process.version}  platform ${process.platform}/${process.arch}\n  dataset: ${days} days of generated activity\n\n`);

const db = await Database.pglite();
await db.migrate();

process.stdout.write('seeding\n');
const seedStart = performance.now();
const demo = await generateDemoOrganization(db, { days, endDate: new Date() });
const seedMs = performance.now() - seedStart;
const rows = Object.values(demo.counts).reduce((a, b) => a + b, 0);
process.stdout.write(`  ${rows.toLocaleString('en-US')} domain rows in ${(seedMs / 1000).toFixed(1)}s (${Object.entries(demo.counts).map(([k, v]) => `${k}=${v}`).join(' ')})\n\n`);

const engine = new MetricEngine(db);
const investigator = new Investigator(db, engine);
const orgId = demo.orgId;
const repos = await db.withOrg(orgId, (sql: ScopedSql) => sql.many<{ id: string }>(`select id from repositories`), 'readonly');
const win = (d: number) => ({ from: new Date(Date.now() - d * MS_PER_DAY).toISOString(), to: new Date().toISOString() });

// ------------------------------------------------------- event ingestion --

process.stdout.write('event ingestion (webhook request path: verify, record, normalize, enqueue)\n');
const SECRET = 'benchmark-secret';
const queue = new PostgresJobQueue(db);
const ingestion = new IngestionService({
  db, queue,
  adapters: new Map([['github', new GitHubWebhookAdapter()]]),
  lookupEndpoint: async () => ({ id: 'bench', orgId, provider: 'github', secret: SECRET }),
});

const makeDelivery = (n: number) => {
  const body = JSON.stringify({
    action: 'opened',
    pull_request: {
      id: 900000 + n, number: 900000 + n, title: `bench ${n}`, state: 'open', draft: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      merged_at: null, closed_at: null, additions: 10, deletions: 2, changed_files: 2, commits: 1,
      base: { ref: 'main' }, head: { ref: `bench/${n}` }, user: { id: 1, login: 'bench', type: 'User' },
    },
    repository: { id: 1, name: 'checkout', full_name: 'northwind/checkout', default_branch: 'main', private: true, owner: { login: 'northwind' } },
    organization: { login: 'northwind' },
  });
  return {
    provider: 'github' as const, endpointId: 'bench', body,
    headers: {
      'x-github-event': 'pull_request',
      'x-github-delivery': `bench-${n}`,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    receivedAt: new Date().toISOString(),
  };
};

const INGEST_N = Number(process.env.BENCH_EVENTS ?? 300);
for (let i = 0; i < 20; i++) await ingestion.receive(makeDelivery(-i - 1));
const ingestStart = performance.now();
for (let i = 0; i < INGEST_N; i++) await ingestion.receive(makeDelivery(i));
throughput('webhook accept (single-threaded)', INGEST_N, performance.now() - ingestStart, 'verify + persist + enqueue; no analytics inline');

const worker = new EventWorker(db, queue, 'bench');
const projectStart = performance.now();
let projected = 0;
for (let i = 0; i < 12; i++) {
  const r = await worker.drain(50);
  projected += r.processed;
  if (r.processed === 0) break;
}
throughput('event projection (worker)', projected, performance.now() - projectStart, 'canonical event -> domain rows, idempotent');

// -------------------------------------------------------- metric queries --

process.stdout.write('\nmetric calculation (org scope, cold reads from raw rows)\n');
await measure('pr_cycle_time, 30d', 15, 3, () =>
  engine.value({ orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: win(30) }));
await measure('pr_cycle_time, 90d', 15, 3, () =>
  engine.value({ orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: win(90) }));
await measure('build_success_rate, 90d', 15, 3, () =>
  engine.value({ orgId, metric: 'build_success_rate', scopeType: 'org', scopeId: orgId, window: win(90) }));
await measure('lead_time_for_changes, 90d (lateral join)', 15, 3, () =>
  engine.value({ orgId, metric: 'lead_time_for_changes', scopeType: 'org', scopeId: orgId, window: win(90) }));
await measure('all 15 metrics, 30d', 5, 1, async () => {
  for (const metric of METRIC_IDS) {
    await engine.value({ orgId, metric, scopeType: 'org', scopeId: orgId, window: win(30) });
  }
}, 'what an overview page costs without snapshots');

process.stdout.write('\ntime series and aggregation\n');
for (const [label, g, d] of [['daily, 90d', 'day', 90], ['weekly, 365d', 'week', 365], ['monthly, 365d', 'month', 365]] as [string, Granularity, number][]) {
  await measure(`pr_cycle_time series (${label})`, 10, 2, () =>
    engine.series({ orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: win(d), granularity: g }));
}
await measure('breakdown by repository, 90d', 10, 2, () =>
  engine.breakdown({ orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: win(90) }, 'repository'));
await measure('breakdown by author, 90d', 10, 2, () =>
  engine.breakdown({ orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: win(90) }, 'author'));

// ------------------------------------------------------------- snapshots --

process.stdout.write('\nsnapshot materialisation\n');
const snapStart = performance.now();
const snapReport = await refreshSnapshots(db, engine, { orgId, window: win(90), granularity: 'day' });
throughput('snapshot buckets written (90d, day, all scopes)', snapReport.buckets, performance.now() - snapStart);

// ---------------------------------------------- detection, investigation --

process.stdout.write('\nchange intelligence\n');
await measure('anomaly detection (org + 4 repos, weekly)', 3, 1, () =>
  runDetection(db, engine, {
    orgId,
    scopes: [{ scopeType: 'org', scopeId: orgId }, ...repos.map((r) => ({ scopeType: 'repository' as const, scopeId: r.id }))],
    granularity: 'week', baselineBuckets: 14,
  }), 'every metric against every scope');

await measure('full investigation (4 dimensions + 7 related)', 3, 1, () =>
  investigator.investigate({ orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: win(21) }));

// ------------------------------------------------------------- reporting --

const lines = [
  '| Benchmark | p50 | p95 | Iterations | Notes |',
  '| --- | ---: | ---: | ---: | --- |',
  ...results.map((r) =>
    r.unit === 'ops/s'
      ? `| ${r.name} | ${r.p50.toFixed(0)} ops/s | — | ${r.iterations} | ${r.note ?? ''} |`
      : `| ${r.name} | ${r.p50.toFixed(1)} ms | ${r.p95.toFixed(1)} ms | ${r.iterations} | ${r.note ?? ''} |`,
  ),
];

process.stdout.write(`\n${lines.join('\n')}\n`);

if (process.env.BENCH_OUT) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(process.env.BENCH_OUT), { recursive: true });
  writeFileSync(
    process.env.BENCH_OUT,
    JSON.stringify({ node: process.version, platform: `${process.platform}/${process.arch}`, days, rows, results }, null, 2),
  );
  process.stdout.write(`\nwrote ${process.env.BENCH_OUT}\n`);
}

await db.close();

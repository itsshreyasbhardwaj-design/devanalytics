/**
 * Loads the demo organization.
 *
 *   pnpm demo:seed                 # embedded database at .pgdata
 *   DATABASE_URL=... pnpm demo:seed
 *
 * The organization is created with is_demo = true, which every surface checks
 * and labels. Seeding also computes snapshots and runs anomaly detection, so
 * the dashboard has real precomputed state rather than an empty shell.
 */
import { Database, provisionOrganization } from '@devanalytics/db';
import { generateDemoOrganization, loadFixture } from '@devanalytics/demo-data';
import { MetricEngine, refreshSnapshots } from '@devanalytics/metrics';
import { persistDetections, runDetection } from '@devanalytics/investigations';
import { createWebhookEndpoint } from '@devanalytics/github';
import { generateApiToken, hashToken } from '@devanalytics/db';
import { MS_PER_DAY } from '@devanalytics/core';

const dataDir = process.env.DEVANALYTICS_EMBEDDED_DATA_DIR ?? '.pgdata';
const days = Number(process.env.DEMO_DAYS ?? 120);
const withFixture = process.env.DEMO_WITH_FIXTURE !== 'false';

const db = process.env.DATABASE_URL
  ? await Database.postgres(process.env.DATABASE_URL)
  : await Database.pglite(dataDir);

const applied = await db.migrate();
console.log(`migrations applied: ${applied.length === 0 ? 'none (already current)' : applied.join(', ')}`);

const started = Date.now();
const demo = await generateDemoOrganization(db, { days, endDate: new Date() });
console.log(`demo organization "${demo.slug}" (${demo.orgId})`);
console.log(`  window     ${demo.windowStart.slice(0, 10)} → ${demo.windowEnd.slice(0, 10)}`);
console.log(`  data       ${Object.entries(demo.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`);
console.log(`  scenario   ${demo.scenario?.description ?? 'none'}`);

const engine = new MetricEngine(db);

const snapshotWindow = { from: demo.windowStart, to: demo.windowEnd };
for (const granularity of ['day', 'week'] as const) {
  const report = await refreshSnapshots(db, engine, { orgId: demo.orgId, window: snapshotWindow, granularity });
  console.log(`  snapshots  ${granularity}: ${report.buckets} buckets in ${report.durationMs} ms`);
}

const repos = await db.withOrg(demo.orgId, (sql) => sql.many<{ id: string }>(`select id from repositories`), 'readonly');
const detections = await runDetection(db, engine, {
  orgId: demo.orgId,
  scopes: [{ scopeType: 'org', scopeId: demo.orgId }, ...repos.map((r) => ({ scopeType: 'repository' as const, scopeId: r.id }))],
  granularity: 'week',
  asOf: new Date(new Date(demo.windowEnd).getTime() - 4 * MS_PER_DAY),
  baselineBuckets: 14,
});
const saved = await persistDetections(db, demo.orgId, detections);
console.log(`  detection  examined ${detections.length} metric/scope pairs, recorded ${saved} anomalies`);

if (withFixture) {
  const fixture = await loadFixture(db);
  console.log(`fixture organization "fixture-co" (${fixture.orgId}) — the hand-derived metric test dataset`);
}

// A webhook endpoint and an API token, so the local instance is immediately usable.
if (process.env.DEVANALYTICS_ENCRYPTION_KEY) {
  const endpoint = await createWebhookEndpoint(db, {
    orgId: demo.orgId, provider: 'github',
    baseUrl: process.env.DEVANALYTICS_BASE_URL ?? 'http://localhost:3117',
    description: 'seeded by demo:seed',
  });
  console.log(`webhook endpoint: ${endpoint.url}`);
  console.log(`  secret (shown once): ${endpoint.secret}`);
} else {
  console.log('webhook endpoint: skipped (set DEVANALYTICS_ENCRYPTION_KEY to create one)');
}

const principalId = 'demo-principal';
await db.unscoped((sql) =>
  sql.query(
    `insert into principals (id, auth_provider, auth_subject, email, display_name)
     values ($1, 'seed', $1, 'demo@example.invalid', 'Demo user') on conflict do nothing`,
    [principalId],
  ),
);
const { token, prefix } = generateApiToken();
await db.withOrg(demo.orgId, (sql) =>
  sql.query(
    `insert into api_tokens (id, org_id, principal_id, name, token_hash, token_prefix, role)
     values ($1,$2,$3,'seeded read-only',$4,$5,'viewer') on conflict (id) do nothing`,
    [`token-seed-${demo.orgId}`, demo.orgId, principalId, hashToken(token), prefix],
  ),
);
await db.unscoped((sql) =>
  sql.query(`insert into org_members (org_id, principal_id, role) values ($1,$2,'owner') on conflict do nothing`, [demo.orgId, principalId]),
);

console.log(`\nviewer API token (shown once): ${token}`);
console.log(`\nseed complete in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.log(`\nNext:`);
console.log(`  DEVANALYTICS_AUTH_MODE=local-dev DEVANALYTICS_LOCAL_ORG_ID=${demo.orgId} pnpm dev`);

await db.close();

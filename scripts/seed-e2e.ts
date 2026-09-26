/**
 * Seeds the disposable end-to-end database.
 *
 * Runs *before* Playwright starts, because Playwright launches its webServer
 * before globalSetup: seeding from globalSetup would delete the database out
 * from under the server that had already opened it.
 */
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { MS_PER_DAY } from '@devanalytics/core';
import { Database, generateApiToken, hashToken } from '@devanalytics/db';
import { generateDemoOrganization } from '@devanalytics/demo-data';
import { MetricEngine, refreshSnapshots } from '@devanalytics/metrics';
import { persistDetections, runDetection } from '@devanalytics/investigations';

const dataDir = process.env.E2E_DATA_DIR ?? '.e2e-pgdata';
rmSync(dataDir, { recursive: true, force: true });

const db = await Database.pglite(dataDir);
await db.migrate();

const demo = await generateDemoOrganization(db, { days: 90, endDate: new Date() });
const engine = new MetricEngine(db);
await refreshSnapshots(db, engine, {
  orgId: demo.orgId,
  window: { from: demo.windowStart, to: demo.windowEnd },
  granularity: 'week',
});

const repos = await db.withOrg(demo.orgId, (sql) => sql.many<{ id: string }>(`select id from repositories`), 'readonly');
const detections = await runDetection(db, engine, {
  orgId: demo.orgId,
  scopes: [{ scopeType: 'org', scopeId: demo.orgId }, ...repos.map((r) => ({ scopeType: 'repository' as const, scopeId: r.id }))],
  granularity: 'week',
  asOf: new Date(new Date(demo.windowEnd).getTime() - 4 * MS_PER_DAY),
  baselineBuckets: 8,
});
await persistDetections(db, demo.orgId, detections);

/**
 * An owner API token for the suite.
 *
 * The end-to-end tests authenticate exactly as a real client does, rather than
 * running the app in its local-development auth mode. That mode refuses to
 * start under NODE_ENV=production, and weakening that guard to make a test
 * suite pass would be the wrong trade: the suite would then stop exercising
 * the authentication path that actually ships.
 */
const principalId = 'e2e-principal';
await db.unscoped((sql) =>
  sql.query(
    `insert into principals (id, auth_provider, auth_subject, email, display_name)
     values ($1, 'e2e', $1, 'e2e@example.invalid', 'E2E') on conflict do nothing`,
    [principalId],
  ),
);
const { token, prefix } = generateApiToken();
await db.withOrg(demo.orgId, (sql) =>
  sql.query(
    `insert into api_tokens (id, org_id, principal_id, name, token_hash, token_prefix, role)
     values ('e2e-token', $1, $2, 'e2e', $3, $4, 'owner')`,
    [demo.orgId, principalId, hashToken(token), prefix],
  ),
);
await db.unscoped((sql) =>
  sql.query(`insert into org_members (org_id, principal_id, role) values ($1,$2,'owner') on conflict do nothing`, [demo.orgId, principalId]),
);
await db.close();

mkdirSync('tests/e2e/.state', { recursive: true });
writeFileSync('tests/e2e/.state/token', token);
writeFileSync('tests/e2e/.state/org', demo.orgId);

console.log(`[e2e] seeded ${demo.slug} (${demo.orgId}) with ${demo.counts.pullRequests} pull requests into ${dataDir}`);

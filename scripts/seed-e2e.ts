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
import { EventWorker, IngestionService, PostgresJobQueue } from '@devanalytics/event-ingestion';
import { GitLabWebhookAdapter } from '@devanalytics/gitlab';

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
 * A GitLab project alongside the generated GitHub ones.
 *
 * Ingested through the real webhook path rather than written directly, so the
 * end-to-end suite exercises multi-provider ingestion and, in particular, the
 * "not reported" pull request size that GitLab webhooks produce.
 */
const GITLAB_SECRET = 'e2e-gitlab-secret';
const queue = new PostgresJobQueue(db);
const ingestion = new IngestionService({
  db,
  queue,
  adapters: new Map([['gitlab', new GitLabWebhookAdapter()]]) as never,
  lookupEndpoint: async () => ({ id: 'e2e-gitlab', orgId: demo.orgId, provider: 'gitlab', secret: GITLAB_SECRET }),
});
const gitlabWorker = new EventWorker(db, queue, 'e2e-seed');

const gitlabProject = {
  id: 4242,
  name: 'ledger',
  path_with_namespace: `${demo.slug}/ledger`,
  default_branch: 'main',
  visibility_level: 0,
  namespace: demo.slug,
  web_url: '',
  homepage: '',
  url: '',
};

const day = (offset: number) => new Date(new Date(demo.windowEnd).getTime() - offset * MS_PER_DAY);
const gitlabStamp = (d: Date) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} UTC`;

for (let i = 0; i < 8; i++) {
  const opened = day(20 - i);
  const merged = new Date(opened.getTime() + (3 + i) * 3_600_000);
  const attributes = {
    id: 90_000 + i,
    iid: 100 + i,
    title: `Reconcile ledger entries (${i + 1})`,
    state: 'merged',
    action: 'merge',
    created_at: gitlabStamp(opened),
    updated_at: gitlabStamp(merged),
    target_branch: 'main',
    source_branch: `ledger/${i}`,
    draft: false,
    merge_commit_sha: `glmerge${String(i).padStart(33, '0')}`,
  };
  const body = JSON.stringify({
    object_kind: 'merge_request',
    user: { id: 8800 + (i % 3), username: ['ines', 'jonas', 'omar'][i % 3], name: 'Platform engineer' },
    project: gitlabProject,
    object_attributes: attributes,
  });
  await ingestion.receive({
    provider: 'gitlab',
    endpointId: 'e2e-gitlab',
    body,
    headers: { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': `e2e-gl-${i}`, 'x-gitlab-token': GITLAB_SECRET },
    receivedAt: new Date().toISOString(),
  });
}
await gitlabWorker.drain(100);

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
const gitlabCount = await db.withOrg(demo.orgId, (sql) =>
  sql.value<number>(`select count(*)::int from pull_requests p join repositories r on r.id = p.repo_id where r.provider = 'gitlab'`),
);
await db.close();

mkdirSync('tests/e2e/.state', { recursive: true });
writeFileSync('tests/e2e/.state/token', token);
writeFileSync('tests/e2e/.state/org', demo.orgId);

console.log(
  `[e2e] seeded ${demo.slug} (${demo.orgId}) with ${demo.counts.pullRequests} GitHub pull requests ` +
    `and ${Number(gitlabCount)} GitLab merge requests into ${dataDir}`,
);

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { provisionOrganization, type Database } from '@devanalytics/db';
import { EventWorker, IngestionService, PostgresJobQueue, QUEUES } from '@devanalytics/event-ingestion';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { MetricEngine } from '@devanalytics/metrics';
import { testDatabase } from '../helpers/db.js';

const SECRET = 'fixture-webhook-secret';
const ENDPOINT_ID = 'endpoint-1';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`;
}

const repo = {
  id: 55,
  name: 'app',
  full_name: 'acme/app',
  default_branch: 'main',
  private: true,
  owner: { login: 'acme' },
};

function delivery(event: string, payload: object, deliveryId = 'd-1') {
  const body = JSON.stringify({ ...payload, repository: repo, organization: { login: 'acme' } });
  return {
    provider: 'github' as const,
    endpointId: ENDPOINT_ID,
    body,
    headers: {
      'x-github-event': event,
      'x-github-delivery': deliveryId,
      'x-hub-signature-256': sign(body),
    },
    receivedAt: new Date('2026-03-10T00:00:00Z').toISOString(),
  };
}

const prBody = (overrides: Record<string, unknown> = {}) => ({
  id: 9001,
  number: 42,
  title: 'Add rate limiting',
  state: 'open',
  draft: false,
  created_at: '2026-03-01T00:00:00Z',
  updated_at: '2026-03-01T00:00:00Z',
  merged_at: null,
  closed_at: null,
  additions: 120,
  deletions: 30,
  changed_files: 6,
  commits: 3,
  merge_commit_sha: null,
  base: { ref: 'main' },
  head: { ref: 'feature/rate-limit' },
  user: { id: 7, login: 'alice', type: 'User' },
  ...overrides,
});

describe('webhook ingestion pipeline', () => {
  let db: Database;
  let queue: PostgresJobQueue;
  let service: IngestionService;
  let worker: EventWorker;
  let orgId: string;

  beforeAll(async () => {
    db = await testDatabase();
    const org = await provisionOrganization(db, { slug: 'acme', name: 'Acme' });
    orgId = org.id;
    queue = new PostgresJobQueue(db);
    service = new IngestionService({
      db,
      queue,
      adapters: new Map([['github', new GitHubWebhookAdapter()]]),
      lookupEndpoint: async (id) =>
        id === ENDPOINT_ID ? { id, orgId, provider: 'github', secret: SECRET } : null,
    });
    worker = new EventWorker(db, queue, 'test-worker');
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it('rejects a body whose signature does not match', async () => {
    const d = delivery('pull_request', { action: 'opened', pull_request: prBody() });
    d.headers['x-hub-signature-256'] = `sha256=${'0'.repeat(64)}`;
    const outcome = await service.receive(d);
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_signature', detail: 'mismatch' });
  });

  it('rejects a body that was tampered with after signing', async () => {
    const d = delivery('pull_request', { action: 'opened', pull_request: prBody() });
    d.body = d.body.replace('Add rate limiting', 'Add rate limitingX');
    const outcome = await service.receive(d);
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_signature' });
  });

  it('rejects an unknown endpoint without revealing that it is unknown', async () => {
    const d = { ...delivery('pull_request', { action: 'opened', pull_request: prBody() }), endpointId: 'nope' };
    const outcome = await service.receive(d);
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_signature' });
  });

  it('accepts a signed delivery and enqueues exactly one job', async () => {
    const before = await queue.depth(QUEUES.events);
    const outcome = await service.receive(delivery('pull_request', { action: 'opened', pull_request: prBody() }, 'd-open'));
    expect(outcome.status).toBe('accepted');
    expect(await queue.depth(QUEUES.events)).toBe(before + 1);
  });

  it('treats a redelivery of the same event as a duplicate', async () => {
    const d = delivery('pull_request', { action: 'opened', pull_request: prBody() }, 'd-open');
    const outcome = await service.receive(d);
    expect(outcome.status).toBe('duplicate');
    const rows = await db.withOrg(orgId, (sql) =>
      sql.many<{ n: number }>(`select count(*)::int as n from events where type = 'pull_request.opened'`),
    );
    expect(Number(rows[0]?.n)).toBe(1);
  });

  it('ignores webhook types it does not model', async () => {
    const outcome = await service.receive(delivery('star', { action: 'created' }, 'd-star'));
    expect(outcome.status).toBe('ignored');
  });

  it('projects events into domain rows when the worker runs', async () => {
    const result = await worker.drain();
    expect(result.failed).toBe(0);
    expect(result.processed).toBeGreaterThan(0);

    const pr = await db.withOrg(orgId, (sql) =>
      sql.one<{ number: number; state: string; additions: number; ready_for_review_at: Date | null }>(
        `select number, state, additions, ready_for_review_at from pull_requests where number = 42`,
      ),
    );
    expect(pr?.number).toBe(42);
    expect(pr?.state).toBe('open');
    expect(pr?.additions).toBe(120);
    expect(pr?.ready_for_review_at).not.toBeNull();
  });

  it('records a merge as a merge, not just a close', async () => {
    await service.receive(
      delivery(
        'pull_request',
        {
          action: 'closed',
          pull_request: prBody({ state: 'closed', merged_at: '2026-03-01T06:00:00Z', closed_at: '2026-03-01T06:00:00Z', merge_commit_sha: 'abc123' }),
        },
        'd-merge',
      ),
    );
    await worker.drain();
    const pr = await db.withOrg(orgId, (sql) =>
      sql.one<{ state: string; merged_at: Date | null }>(`select state, merged_at from pull_requests where number = 42`),
    );
    expect(pr?.state).toBe('merged');
    expect(pr?.merged_at).not.toBeNull();
  });

  it('does not let a late close event undo a merge', async () => {
    await service.receive(
      delivery('pull_request', { action: 'closed', pull_request: prBody({ state: 'closed', merged_at: null, closed_at: '2026-03-02T00:00:00Z' }) }, 'd-late-close'),
    );
    await worker.drain();
    const pr = await db.withOrg(orgId, (sql) =>
      sql.one<{ state: string }>(`select state from pull_requests where number = 42`),
    );
    expect(pr?.state).toBe('merged');
  });

  it('schedules narrow metric work rather than a full recompute', async () => {
    const jobs = await db.unscoped((sql) =>
      sql.query<{ payload: unknown }>(`select payload from job_queue where queue = $1`, [QUEUES.snapshots]),
    );
    expect(jobs.rows.length).toBeGreaterThan(0);
    const payloads = jobs.rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload));
    expect(payloads.every((p: { bucketStart: string; granularity: string }) => Boolean(p.bucketStart && p.granularity))).toBe(true);
    expect(new Set(payloads.map((p: { granularity: string }) => p.granularity))).toEqual(new Set(['day', 'week', 'month']));
  });

  it('makes reviews visible to the metric engine end to end', async () => {
    await service.receive(
      delivery(
        'pull_request_review',
        {
          action: 'submitted',
          review: { id: 555, state: 'approved', submitted_at: '2026-03-01T03:00:00Z', user: { id: 8, login: 'bob', type: 'User' } },
          pull_request: prBody({ merged_at: '2026-03-01T06:00:00Z', state: 'closed' }),
        },
        'd-review',
      ),
    );
    await worker.drain();

    const engine = new MetricEngine(db);
    const cycle = await engine.value({
      orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId,
      window: { from: '2026-03-01T00:00:00Z', to: '2026-03-08T00:00:00Z' },
    });
    // One merged PR is below the metric's minimum sample of 5.
    expect(cycle.result).toMatchObject({ status: 'insufficient_data', sampleSize: 1 });

    const firstReview = await db.withOrg(orgId, (sql) =>
      sql.one<{ first_review_at: Date | null; first_approval_at: Date | null }>(
        `select first_review_at, first_approval_at from pull_requests where number = 42`,
      ),
    );
    expect(firstReview?.first_review_at?.toISOString()).toBe('2026-03-01T03:00:00.000Z');
    expect(firstReview?.first_approval_at?.toISOString()).toBe('2026-03-01T03:00:00.000Z');
  });
});

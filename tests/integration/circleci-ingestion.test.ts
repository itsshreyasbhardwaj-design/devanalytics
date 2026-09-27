import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { provisionOrganization, type Database } from '@devanalytics/db';
import { EventWorker, IngestionService, PostgresJobQueue } from '@devanalytics/event-ingestion';
import { CircleCiWebhookAdapter } from '@devanalytics/circleci';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { MetricEngine } from '@devanalytics/metrics';
import { testDatabase } from '../helpers/db.js';
import { workflowCompleted } from '../helpers/circleci-payloads.js';

const CIRCLE_SECRET = 'circle-secret';
const GITHUB_SECRET = 'github-secret';
const CIRCLE_ENDPOINT = 'endpoint-circleci';
const GITHUB_ENDPOINT = 'endpoint-github';
const WINDOW = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };
const HEAD_SHA = 'abc1560886d4f094c3e6c9ef40349f7d38b5d27d';

describe('CircleCI ingestion: a CI-only provider', () => {
  let db: Database;
  let service: IngestionService;
  let worker: EventWorker;
  let engine: MetricEngine;
  let orgId: string;
  let seq = 0;

  beforeAll(async () => {
    db = await testDatabase();
    const org = await provisionOrganization(db, { slug: 'acme', name: 'Acme' });
    orgId = org.id;
    const queue = new PostgresJobQueue(db);
    service = new IngestionService({
      db,
      queue,
      adapters: new Map<string, GitHubWebhookAdapter>([
        ['github', new GitHubWebhookAdapter()],
        ['circleci', new CircleCiWebhookAdapter() as unknown as GitHubWebhookAdapter],
      ]),
      lookupEndpoint: async (id) =>
        id === CIRCLE_ENDPOINT
          ? { id, orgId, provider: 'circleci', secret: CIRCLE_SECRET }
          : id === GITHUB_ENDPOINT
            ? { id, orgId, provider: 'github', secret: GITHUB_SECRET }
            : null,
    });
    worker = new EventWorker(db, queue, 'circleci-test');
    engine = new MetricEngine(db);
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const sendCircle = async (payload: Record<string, unknown>) => {
    const body = JSON.stringify({ ...payload, id: `evt-${++seq}` });
    return service.receive({
      provider: 'circleci',
      endpointId: CIRCLE_ENDPOINT,
      body,
      headers: {
        'circleci-event-type': String(payload.type ?? 'workflow-completed'),
        'circleci-signature': `v1=${createHmac('sha256', CIRCLE_SECRET).update(body, 'utf8').digest('hex')}`,
      },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });
  };

  const sendGitHub = async (event: string, payload: Record<string, unknown>, deliveryId: string) => {
    const body = JSON.stringify({
      ...payload,
      repository: { id: 900, name: 'api', full_name: 'acme/api', default_branch: 'main', private: true, owner: { login: 'acme' } },
      organization: { login: 'acme' },
    });
    return service.receive({
      provider: 'github',
      endpointId: GITHUB_ENDPOINT,
      body,
      headers: {
        'x-github-event': event,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': `sha256=${createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`,
      },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });
  };

  it('rejects a wrongly signed delivery', async () => {
    const body = JSON.stringify(workflowCompleted());
    const outcome = await service.receive({
      provider: 'circleci',
      endpointId: CIRCLE_ENDPOINT,
      body,
      headers: { 'circleci-event-type': 'workflow-completed', 'circleci-signature': `v1=${'0'.repeat(64)}` },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_signature' });
  });

  it('attaches its run to the repository GitHub already connected', async () => {
    // GitHub connects acme/api first, with its real numeric id.
    await sendGitHub('pull_request', {
      action: 'opened',
      pull_request: {
        id: 5001, number: 7, title: 'Add rate limiting', state: 'open', draft: false,
        created_at: '2026-03-01T09:00:00Z', updated_at: '2026-03-01T09:00:00Z',
        merged_at: null, closed_at: null, additions: 80, deletions: 20, changed_files: 4, commits: 1,
        base: { ref: 'main' }, head: { ref: 'feature/rate-limit' },
        user: { id: 9, login: 'ana', type: 'User' },
      },
    }, 'gh-open');
    await worker.drain();

    await sendCircle(workflowCompleted());
    await worker.drain();

    const repos = await db.withOrg(orgId, (sql) =>
      sql.many<{ id: string; full_name: string; provider: string; provider_repo_id: string }>(
        `select id, full_name, provider, provider_repo_id from repositories order by full_name`,
      ),
    );
    // Exactly one repository. A second row under provider 'circleci' would put
    // pull requests on one and CI runs on the other, and build success rate
    // scoped to the connected repository would report nothing.
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ full_name: 'acme/api', provider: 'github', provider_repo_id: '900' });

    const run = await db.withOrg(orgId, (sql) =>
      sql.one<{ repo_id: string; conclusion: string | null; enqueued_at: Date | null; started_at: Date | null; completed_at: Date | null }>(
        `select repo_id, conclusion, enqueued_at, started_at, completed_at from workflow_runs`,
      ),
    );
    expect(run?.repo_id).toBe(repos[0]?.id);
    expect(run?.conclusion).toBe('success');
    // CircleCI reports no runner wait.
    expect(run?.enqueued_at).toBeNull();
    expect(run?.started_at?.toISOString()).toBe('2026-03-01T10:01:30.000Z');
    expect(run?.completed_at?.toISOString()).toBe('2026-03-01T10:07:00.000Z');
  });

  it('records the CircleCI workflow name so CI can be grouped by it', async () => {
    const workflow = await db.withOrg(orgId, (sql) =>
      sql.one<{ name: string; path: string | null; provider: string }>(`select name, path, provider from workflows`),
    );
    expect(workflow).toMatchObject({ name: 'build-and-test', path: '.circleci/config.yml', provider: 'circleci' });
  });

  it('links the run to a pull request through the commit it built', async () => {
    // CircleCI reports a revision and a branch, never a pull request number.
    // The link exists only once the commit is known to belong to a PR.
    await sendGitHub('push', {
      ref: 'refs/heads/feature/rate-limit',
      after: HEAD_SHA,
      commits: [{ id: HEAD_SHA, message: 'Add rate limiting', timestamp: '2026-03-01T09:55:00Z', author: { username: 'ana', name: 'Ana' } }],
      sender: { id: 9, login: 'ana', type: 'User' },
    }, 'gh-push');
    await worker.drain();

    await db.withOrg(orgId, (sql) =>
      sql.query(`update commits set pull_request_id = (select id from pull_requests limit 1) where sha = $1`, [HEAD_SHA]),
    );

    // Redeliver the CircleCI event; projection is idempotent and re-resolves.
    await sendCircle(workflowCompleted());
    await worker.drain();

    const run = await db.withOrg(orgId, (sql) =>
      sql.one<{ pull_request_id: string | null }>(`select pull_request_id from workflow_runs where head_sha = $1`, [HEAD_SHA]),
    );
    expect(run?.pull_request_id).not.toBeNull();
  });

  it('excludes CircleCI runs from CI queue time but not from build duration', async () => {
    const scope = { orgId, scopeType: 'org' as const, scopeId: orgId, window: WINDOW };

    const queue = await engine.value({ ...scope, metric: 'ci_queue_time' });
    // No sample at all: reporting these as an instant queue would be a
    // measurement of something CircleCI never measured.
    expect(queue.result).toMatchObject({ status: 'insufficient_data', sampleSize: 0 });

    const duration = await engine.facts({ ...scope, metric: 'build_duration' });
    expect(duration).toHaveLength(1);
    // 10:01:30 to 10:07:00 is five and a half minutes.
    expect(duration[0]?.val).toBeCloseTo(5.5, 6);

    const success = await engine.facts({ ...scope, metric: 'build_success_rate' });
    expect(success).toHaveLength(1);
    expect(success[0]?.val).toBe(1);
  });

  it('keeps GitHub queue times measurable alongside CircleCI runs', async () => {
    await sendGitHub('workflow_run', {
      action: 'completed',
      workflow: { id: 77, name: 'CI', path: '.github/workflows/ci.yml' },
      workflow_run: {
        id: 12345, run_attempt: 1, head_sha: HEAD_SHA, head_branch: 'feature/rate-limit',
        event: 'pull_request', status: 'completed', conclusion: 'success',
        created_at: '2026-03-02T10:00:00Z',
        run_started_at: '2026-03-02T10:02:00Z',
        updated_at: '2026-03-02T10:09:00Z',
        workflow_id: 77, pull_requests: [{ number: 7 }],
        actor: { id: 9, login: 'ana', type: 'User' },
      },
    }, 'gh-run');
    await worker.drain();

    const scope = { orgId, scopeType: 'org' as const, scopeId: orgId, window: WINDOW };
    const queue = await engine.facts({ ...scope, metric: 'ci_queue_time' });
    // Only the GitHub run, which does report an enqueue time: two minutes.
    expect(queue).toHaveLength(1);
    expect(queue[0]?.val).toBeCloseTo(2, 6);

    const duration = await engine.facts({ ...scope, metric: 'build_duration' });
    // Both providers contribute duration.
    expect(duration).toHaveLength(2);
  });

  it('treats a redelivery as a duplicate', async () => {
    const payload = { ...workflowCompleted(), id: 'stable-event-id' };
    const body = JSON.stringify(payload);
    const headers = {
      'circleci-event-type': 'workflow-completed',
      'circleci-signature': `v1=${createHmac('sha256', CIRCLE_SECRET).update(body, 'utf8').digest('hex')}`,
    };
    const first = await service.receive({ provider: 'circleci', endpointId: CIRCLE_ENDPOINT, body, headers, receivedAt: '2026-03-08T00:00:00.000Z' });
    const second = await service.receive({ provider: 'circleci', endpointId: CIRCLE_ENDPOINT, body, headers, receivedAt: '2026-03-08T00:10:00.000Z' });
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
  });
});

describe('CircleCI for a repository the code host has not connected', () => {
  let db: Database;
  let service: IngestionService;
  let worker: EventWorker;
  let orgId: string;

  beforeAll(async () => {
    db = await testDatabase();
    const org = await provisionOrganization(db, { slug: 'acme', name: 'Acme' });
    orgId = org.id;
    const queue = new PostgresJobQueue(db);
    service = new IngestionService({
      db,
      queue,
      adapters: new Map<string, GitHubWebhookAdapter>([
        ['github', new GitHubWebhookAdapter()],
        ['circleci', new CircleCiWebhookAdapter() as unknown as GitHubWebhookAdapter],
      ]),
      lookupEndpoint: async (id) =>
        id === CIRCLE_ENDPOINT
          ? { id, orgId, provider: 'circleci', secret: CIRCLE_SECRET }
          : { id, orgId, provider: 'github', secret: GITHUB_SECRET },
    });
    worker = new EventWorker(db, queue, 'circleci-first');
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it('records the repository under its code host, with a marked placeholder id', async () => {
    const body = JSON.stringify(workflowCompleted());
    await service.receive({
      provider: 'circleci', endpointId: CIRCLE_ENDPOINT, body,
      headers: {
        'circleci-event-type': 'workflow-completed',
        'circleci-signature': `v1=${createHmac('sha256', CIRCLE_SECRET).update(body, 'utf8').digest('hex')}`,
      },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });
    await worker.drain();

    const repo = await db.withOrg(orgId, (sql) =>
      sql.one<{ provider: string; full_name: string; provider_repo_id: string }>(
        `select provider, full_name, provider_repo_id from repositories`,
      ),
    );
    // Filed under GitHub, because that is where it lives, with an id that
    // says plainly it was discovered by CircleCI rather than fetched.
    expect(repo).toMatchObject({ provider: 'github', full_name: 'acme/api', provider_repo_id: 'circleci:acme/api' });
  });

  it('adopts that row when GitHub connects later, rather than duplicating it', async () => {
    const body = JSON.stringify({
      action: 'opened',
      pull_request: {
        id: 5001, number: 7, title: 'Add rate limiting', state: 'open', draft: false,
        created_at: '2026-03-01T09:00:00Z', updated_at: '2026-03-01T09:00:00Z',
        merged_at: null, closed_at: null, additions: 80, deletions: 20, changed_files: 4, commits: 1,
        base: { ref: 'main' }, head: { ref: 'feature/rate-limit' }, user: { id: 9, login: 'ana', type: 'User' },
      },
      repository: { id: 900, name: 'api', full_name: 'acme/api', default_branch: 'develop', private: false, owner: { login: 'acme' } },
      organization: { login: 'acme' },
    });
    await service.receive({
      provider: 'github', endpointId: GITHUB_ENDPOINT, body,
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'gh-late',
        'x-hub-signature-256': `sha256=${createHmac('sha256', GITHUB_SECRET).update(body).digest('hex')}`,
      },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });
    await worker.drain();

    const repos = await db.withOrg(orgId, (sql) =>
      sql.many<{ id: string; provider_repo_id: string; default_branch: string; is_private: boolean }>(
        `select id, provider_repo_id, default_branch, is_private from repositories`,
      ),
    );
    // Still one repository, now carrying GitHub's real id and real metadata.
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ provider_repo_id: '900', default_branch: 'develop', is_private: false });

    // And the CI run recorded before the code host connected is still attached.
    const run = await db.withOrg(orgId, (sql) =>
      sql.one<{ repo_id: string }>(`select repo_id from workflow_runs`),
    );
    expect(run?.repo_id).toBe(repos[0]?.id);
  });
});

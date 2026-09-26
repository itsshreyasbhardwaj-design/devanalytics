import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { provisionOrganization, type Database } from '@devanalytics/db';
import { EventWorker, IngestionService, PostgresJobQueue } from '@devanalytics/event-ingestion';
import { GitLabWebhookAdapter } from '@devanalytics/gitlab';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { MetricEngine } from '@devanalytics/metrics';
import { testDatabase } from '../helpers/db.js';
import { deploymentHook, mergeRequestHook, noteHook, pipelineHook, pushHook, REVIEWER } from '../helpers/gitlab-payloads.js';

const GITLAB_SECRET = 'gitlab-secret';
const GITHUB_SECRET = 'github-secret';
const GITLAB_ENDPOINT = 'endpoint-gitlab';
const GITHUB_ENDPOINT = 'endpoint-github';
const WINDOW = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };

describe('GitLab ingestion end to end', () => {
  let db: Database;
  let service: IngestionService;
  let worker: EventWorker;
  let engine: MetricEngine;
  let orgId: string;
  let uuid = 0;

  beforeAll(async () => {
    db = await testDatabase();
    // GitLab nests groups, so this project lives at northwind/payments/checkout
    // and its organization slug is the whole namespace above the project.
    const org = await provisionOrganization(db, { slug: 'northwind/payments', name: 'Northwind Payments' });
    orgId = org.id;

    const queue = new PostgresJobQueue(db);
    service = new IngestionService({
      db,
      queue,
      adapters: new Map<string, GitLabWebhookAdapter | GitHubWebhookAdapter>([
        ['gitlab', new GitLabWebhookAdapter()],
        ['github', new GitHubWebhookAdapter()],
      ]) as never,
      lookupEndpoint: async (id) =>
        id === GITLAB_ENDPOINT
          ? { id, orgId, provider: 'gitlab', secret: GITLAB_SECRET }
          : id === GITHUB_ENDPOINT
            ? { id, orgId, provider: 'github', secret: GITHUB_SECRET }
            : null,
    });
    worker = new EventWorker(db, queue, 'gitlab-test');
    engine = new MetricEngine(db);
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const sendGitLab = async (event: string, body: unknown) =>
    service.receive({
      provider: 'gitlab',
      endpointId: GITLAB_ENDPOINT,
      body: JSON.stringify(body),
      headers: {
        'x-gitlab-event': event,
        'x-gitlab-event-uuid': `uuid-${++uuid}`,
        'x-gitlab-token': GITLAB_SECRET,
      },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });

  it('rejects a delivery with the wrong token', async () => {
    const outcome = await service.receive({
      provider: 'gitlab',
      endpointId: GITLAB_ENDPOINT,
      body: JSON.stringify(pushHook()),
      headers: { 'x-gitlab-event': 'Push Hook', 'x-gitlab-event-uuid': 'bad', 'x-gitlab-token': 'wrong' },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });
    expect(outcome).toMatchObject({ status: 'rejected', reason: 'invalid_signature', detail: 'mismatch' });
  });

  it('accepts a signed delivery and projects a merge request', async () => {
    expect((await sendGitLab('Merge Request Hook', mergeRequestHook())).status).toBe('accepted');
    const result = await worker.drain();
    expect(result.failed).toBe(0);

    const pr = await db.withOrg(orgId, (sql) =>
      sql.one<{ number: number; state: string; base_branch: string; additions: number | null; ready_for_review_at: Date | null }>(
        `select number, state, base_branch, additions, ready_for_review_at from pull_requests`,
      ),
    );
    // iid, not id.
    expect(pr?.number).toBe(42);
    expect(pr?.state).toBe('open');
    expect(pr?.base_branch).toBe('main');
    expect(pr?.ready_for_review_at).not.toBeNull();
    // The merge request hook carries no diff statistics, so size is unknown
    // rather than zero.
    expect(pr?.additions).toBeNull();
  });

  it('creates the repository under the nested group namespace', async () => {
    const repo = await db.withOrg(orgId, (sql) =>
      sql.one<{ full_name: string; provider: string; default_branch: string; is_private: boolean }>(
        `select full_name, provider, default_branch, is_private from repositories`,
      ),
    );
    expect(repo).toMatchObject({
      full_name: 'northwind/payments/checkout',
      provider: 'gitlab',
      default_branch: 'main',
      is_private: true,
    });
  });

  it('records an approval as a review with the right timestamp', async () => {
    await sendGitLab('Merge Request Hook', mergeRequestHook({ action: 'approved', updated_at: '2026-03-01 12:00:00 UTC' }, { user: REVIEWER }));
    await worker.drain();

    const review = await db.withOrg(orgId, (sql) =>
      sql.one<{ state: string; submitted_at: Date; login: string | null }>(
        `select rv.state, rv.submitted_at, u.login
           from reviews rv left join users u on u.id = rv.reviewer_user_id limit 1`,
      ),
    );
    expect(review?.state).toBe('approved');
    expect(review?.login).toBe('devon');
    expect(review?.submitted_at.toISOString()).toBe('2026-03-01T12:00:00.000Z');

    const pr = await db.withOrg(orgId, (sql) =>
      sql.one<{ first_review_at: Date | null; first_approval_at: Date | null }>(
        `select first_review_at, first_approval_at from pull_requests where number = 42`,
      ),
    );
    expect(pr?.first_review_at?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(pr?.first_approval_at?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
  });

  it('records an inline diff comment', async () => {
    await sendGitLab('Note Hook', noteHook());
    await worker.drain();
    const comment = await db.withOrg(orgId, (sql) =>
      sql.one<{ path: string | null; created_at: Date }>(`select path, created_at from review_comments limit 1`),
    );
    expect(comment?.path).toBe('src/checkout.ts');
    expect(comment?.created_at.toISOString()).toBe('2026-03-01T11:30:00.000Z');
  });

  it('records a merge as a merge and starts the cycle-time clock correctly', async () => {
    await sendGitLab('Merge Request Hook', mergeRequestHook({
      action: 'merge', state: 'merged', updated_at: '2026-03-01 17:00:00 UTC',
      merge_commit_sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
    }));
    await worker.drain();

    const pr = await db.withOrg(orgId, (sql) =>
      sql.one<{ state: string; merged_at: Date | null; ready_for_review_at: Date | null; merge_commit_sha: string | null }>(
        `select state, merged_at, ready_for_review_at, merge_commit_sha from pull_requests where number = 42`,
      ),
    );
    expect(pr?.state).toBe('merged');
    expect(pr?.merged_at?.toISOString()).toBe('2026-03-01T17:00:00.000Z');
    // Ready at 09:00, merged at 17:00 — an eight-hour cycle.
    expect(pr?.ready_for_review_at?.toISOString()).toBe('2026-03-01T09:00:00.000Z');
    expect(pr?.merge_commit_sha).toBe('da1560886d4f094c3e6c9ef40349f7d38b5d27d7');
  });

  it('projects a pipeline with a reconstructed start time', async () => {
    await sendGitLab('Pipeline Hook', pipelineHook());
    await worker.drain();

    const run = await db.withOrg(orgId, (sql) =>
      sql.one<{ conclusion: string | null; created_at: Date; started_at: Date | null; completed_at: Date | null; event: string; pull_request_id: string | null }>(
        `select conclusion, created_at, started_at, completed_at, event, pull_request_id from workflow_runs limit 1`,
      ),
    );
    expect(run?.conclusion).toBe('success');
    expect(run?.event).toBe('merge_request_event');
    expect(run?.created_at.toISOString()).toBe('2026-03-01T10:00:00.000Z');
    // created + 45s queued.
    expect(run?.started_at?.toISOString()).toBe('2026-03-01T10:00:45.000Z');
    expect(run?.completed_at?.toISOString()).toBe('2026-03-01T10:07:00.000Z');
    // Linked to the merge request by iid.
    expect(run?.pull_request_id).not.toBeNull();
  });

  it('attributes a deployment to its merge request using the recovered full sha', async () => {
    await sendGitLab('Deployment Hook', deploymentHook());
    await worker.drain();

    const deployment = await db.withOrg(orgId, (sql) =>
      sql.one<{ sha: string; is_production: boolean; state: string; pull_request_id: string | null }>(
        `select sha, is_production, state, pull_request_id from deployments limit 1`,
      ),
    );
    expect(deployment?.sha).toBe('da1560886d4f094c3e6c9ef40349f7d38b5d27d7');
    expect(deployment?.is_production).toBe(true);
    expect(deployment?.state).toBe('success');
    // Without recovering the full sha from commit_url, this link — and
    // therefore lead time for changes — would be impossible.
    expect(deployment?.pull_request_id).not.toBeNull();
  });

  it('computes metrics from GitLab data', async () => {
    const scope = { orgId, scopeType: 'org' as const, scopeId: orgId, window: WINDOW };

    const ttfr = await engine.value({ ...scope, metric: 'time_to_first_review' });
    // 09:00 ready, 12:00 first review. One observation, below the minimum of 5.
    expect(ttfr.result).toMatchObject({ status: 'insufficient_data', sampleSize: 1 });

    const queue = await engine.value({ ...scope, metric: 'ci_queue_time' });
    expect(queue.result.sampleSize).toBe(1);

    const facts = await engine.facts({ ...scope, metric: 'pr_cycle_time' });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.val).toBeCloseTo(8, 6);
  });

  it('excludes unknown-size merge requests from PR size rather than counting them as zero', async () => {
    const size = await engine.value({ orgId, metric: 'pr_size', scopeType: 'org', scopeId: orgId, window: WINDOW });
    // The single GitLab merge request has no diff statistics, so there is
    // nothing to measure — not a zero-line pull request.
    expect(size.result).toMatchObject({ status: 'insufficient_data', sampleSize: 0 });
    expect(size.excluded).toEqual({
      count: 1,
      reason: expect.stringMatching(/did not report diff statistics/),
    });
  });

  it('treats a redelivery of the same GitLab event as a duplicate', async () => {
    const body = JSON.stringify(mergeRequestHook({ action: 'reopen', state: 'opened' }));
    const headers = { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'retry-uuid', 'x-gitlab-token': GITLAB_SECRET };
    const first = await service.receive({ provider: 'gitlab', endpointId: GITLAB_ENDPOINT, body, headers, receivedAt: '2026-03-08T00:00:00.000Z' });
    const second = await service.receive({ provider: 'gitlab', endpointId: GITLAB_ENDPOINT, body, headers, receivedAt: '2026-03-08T00:05:00.000Z' });
    expect(first.status).toBe('accepted');
    expect(second.status).toBe('duplicate');
  });
});

describe('GitHub and GitLab in one organization', () => {
  let db: Database;
  let service: IngestionService;
  let worker: EventWorker;
  let engine: MetricEngine;
  let orgId: string;

  beforeAll(async () => {
    db = await testDatabase();
    const org = await provisionOrganization(db, { slug: 'acme', name: 'Acme' });
    orgId = org.id;
    const queue = new PostgresJobQueue(db);
    service = new IngestionService({
      db,
      queue,
      adapters: new Map<string, GitLabWebhookAdapter | GitHubWebhookAdapter>([
        ['gitlab', new GitLabWebhookAdapter()],
        ['github', new GitHubWebhookAdapter()],
      ]) as never,
      lookupEndpoint: async (id) =>
        id === GITLAB_ENDPOINT
          ? { id, orgId, provider: 'gitlab', secret: GITLAB_SECRET }
          : { id, orgId, provider: 'github', secret: GITHUB_SECRET },
    });
    worker = new EventWorker(db, queue, 'mixed-test');
    engine = new MetricEngine(db);
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it('computes one set of metrics across both providers', async () => {
    // A GitLab merge request under the acme namespace.
    const gitlabProject = {
      id: 77, name: 'billing', path_with_namespace: 'acme/billing',
      default_branch: 'main', visibility_level: 0, namespace: 'acme',
      web_url: '', homepage: '', url: '',
    };
    await service.receive({
      provider: 'gitlab',
      endpointId: GITLAB_ENDPOINT,
      body: JSON.stringify(mergeRequestHook(
        { action: 'merge', state: 'merged', created_at: '2026-03-02 09:00:00 UTC', updated_at: '2026-03-02 13:00:00 UTC' },
        { project: gitlabProject },
      )),
      headers: { 'x-gitlab-event': 'Merge Request Hook', 'x-gitlab-event-uuid': 'mixed-1', 'x-gitlab-token': GITLAB_SECRET },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });

    // A GitHub pull request in the same organization.
    const githubBody = JSON.stringify({
      action: 'closed',
      pull_request: {
        id: 5001, number: 7, title: 'Tighten webhook validation', state: 'closed', draft: false,
        created_at: '2026-03-03T09:00:00Z', updated_at: '2026-03-03T11:00:00Z',
        merged_at: '2026-03-03T11:00:00Z', closed_at: '2026-03-03T11:00:00Z',
        additions: 80, deletions: 20, changed_files: 4, commits: 2, merge_commit_sha: 'gh-merge',
        base: { ref: 'main' }, head: { ref: 'fix/webhooks' }, user: { id: 9, login: 'wei', type: 'User' },
      },
      repository: { id: 900, name: 'gateway', full_name: 'acme/gateway', default_branch: 'main', private: true, owner: { login: 'acme' } },
      organization: { login: 'acme' },
    });
    await service.receive({
      provider: 'github',
      endpointId: GITHUB_ENDPOINT,
      body: githubBody,
      headers: {
        'x-github-event': 'pull_request',
        'x-github-delivery': 'mixed-gh-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', GITHUB_SECRET).update(githubBody).digest('hex')}`,
      },
      receivedAt: '2026-03-08T00:00:00.000Z',
    });

    await worker.drain();

    const repos = await db.withOrg(orgId, (sql) =>
      sql.many<{ full_name: string; provider: string }>(`select full_name, provider from repositories order by full_name`),
    );
    expect(repos).toEqual([
      { full_name: 'acme/billing', provider: 'gitlab' },
      { full_name: 'acme/gateway', provider: 'github' },
    ]);

    // Cycle time spans both providers: GitLab 4h, GitHub 2h.
    const facts = await engine.facts({
      orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: WINDOW,
    });
    expect(facts.map((f) => f.val).sort()).toEqual([2, 4]);

    // PR size counts only the pull request whose provider reported a size.
    const size = await engine.value({ orgId, metric: 'pr_size', scopeType: 'org', scopeId: orgId, window: WINDOW });
    expect(size.result.sampleSize).toBe(1);
    expect(size.excluded?.count).toBe(1);
  });

  it('breaks a metric down by repository across providers', async () => {
    const rows = await engine.breakdown(
      { orgId, metric: 'pr_cycle_time', scopeType: 'org', scopeId: orgId, window: WINDOW },
      'repository',
    );
    expect(rows.map((r) => r.label).sort()).toEqual(['acme/billing', 'acme/gateway']);
  });
});

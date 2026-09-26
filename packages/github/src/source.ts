import {
  canonicalEventSchema,
  eventIdempotencyKey,
  type BackfillCursor,
  type BackfillPage,
  type CanonicalEvent,
  type CanonicalEventType,
  type RepositorySource,
  type TimeWindow,
} from '@devanalytics/core';

/**
 * GitHub REST backfill.
 *
 * Backfill emits the same canonical events as the webhook path and writes
 * through the same idempotent insert, so history and live traffic converge
 * instead of double-counting where they overlap.
 */

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitHubClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  /** Called when the REST rate limit is exhausted; defaults to sleeping until reset. */
  onRateLimit?: (resetAtMs: number) => Promise<void>;
}

export class GitHubRateLimitError extends Error {
  constructor(readonly resetAtMs: number) {
    super(`GitHub rate limit exhausted; resets at ${new Date(resetAtMs).toISOString()}`);
    this.name = 'GitHubRateLimitError';
  }
}

type Json = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numStr = (v: unknown): string | null => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);

export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  rateLimitRemaining: number | null = null;

  constructor(private readonly opts: GitHubClientOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.github.com';
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async get<T = unknown>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await this.fetchImpl(url, {
      headers: {
        // The token is server-side only. It is never returned by any API route
        // and never reaches a browser.
        authorization: `Bearer ${this.opts.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'devanalytics',
      },
    });
    const remaining = res.headers.get('x-ratelimit-remaining');
    this.rateLimitRemaining = remaining === null ? null : Number(remaining);

    if (res.status === 403 && this.rateLimitRemaining === 0) {
      const reset = Number(res.headers.get('x-ratelimit-reset') ?? 0) * 1000;
      if (this.opts.onRateLimit) await this.opts.onRateLimit(reset);
      else throw new GitHubRateLimitError(reset);
    }
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

interface RepoMeta {
  providerRepoId: string;
  fullName: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export class GitHubSource implements RepositorySource {
  readonly provider = 'github' as const;

  constructor(private readonly client: GitHubClient) {}

  async backfill(input: {
    orgSlug: string;
    repoFullName: string;
    window: TimeWindow;
    cursor: BackfillCursor;
    pageSize: number;
  }): Promise<BackfillPage> {
    const page = input.cursor.token ? Number(input.cursor.token) : 1;
    const repo = await this.repoMeta(input.repoFullName);

    const prs = await this.client.get<Json[]>(
      `/repos/${input.repoFullName}/pulls?state=all&sort=updated&direction=desc&per_page=${input.pageSize}&page=${page}`,
    );

    const events: CanonicalEvent[] = [];
    let reachedWindowStart = false;

    for (const pr of prs) {
      const updatedAt = s(pr.updated_at);
      if (updatedAt && new Date(updatedAt) < new Date(input.window.from)) {
        // Results are sorted by update time, so once we pass the window we can
        // stop paging rather than walking the whole repository history.
        reachedWindowStart = true;
        continue;
      }
      events.push(...this.prEvents(input.orgSlug, repo, pr));

      const number = typeof pr.number === 'number' ? pr.number : Number(pr.number);
      const reviews = await this.client.get<Json[]>(`/repos/${input.repoFullName}/pulls/${number}/reviews?per_page=100`);
      for (const review of reviews) {
        events.push(this.reviewEvent(input.orgSlug, repo, pr, review));
      }
    }

    return {
      events,
      cursor: { token: String(page + 1), done: prs.length < input.pageSize || reachedWindowStart },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  async backfillWorkflowRuns(orgSlug: string, repoFullName: string, window: TimeWindow, page = 1, pageSize = 100): Promise<BackfillPage> {
    const repo = await this.repoMeta(repoFullName);
    const created = `${window.from.slice(0, 10)}..${window.to.slice(0, 10)}`;
    const res = await this.client.get<{ workflow_runs?: Json[] }>(
      `/repos/${repoFullName}/actions/runs?per_page=${pageSize}&page=${page}&created=${created}`,
    );
    const runs = res.workflow_runs ?? [];
    const events = runs.map((run) => this.runEvent(orgSlug, repo, run));
    return {
      events,
      cursor: { token: String(page + 1), done: runs.length < pageSize },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  async backfillDeployments(orgSlug: string, repoFullName: string, page = 1, pageSize = 100): Promise<BackfillPage> {
    const repo = await this.repoMeta(repoFullName);
    const deployments = await this.client.get<Json[]>(`/repos/${repoFullName}/deployments?per_page=${pageSize}&page=${page}`);
    const events: CanonicalEvent[] = [];
    for (const deployment of deployments) {
      const statuses = await this.client.get<Json[]>(
        `/repos/${repoFullName}/deployments/${numStr(deployment.id)}/statuses?per_page=1`,
      );
      events.push(this.deploymentEvent(orgSlug, repo, deployment, statuses[0] ?? null));
    }
    return {
      events,
      cursor: { token: String(page + 1), done: deployments.length < pageSize },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  private async repoMeta(fullName: string): Promise<RepoMeta> {
    const r = await this.client.get<Json>(`/repos/${fullName}`);
    return {
      providerRepoId: numStr(r.id) ?? '',
      fullName: s(r.full_name) ?? fullName,
      name: s(r.name) ?? fullName.split('/')[1] ?? fullName,
      defaultBranch: s(r.default_branch) ?? 'main',
      isPrivate: r.private === true,
    };
  }

  private build(
    orgSlug: string,
    repo: RepoMeta,
    type: CanonicalEventType,
    occurredAt: string,
    subjectId: string,
    payload: Json,
    actor: Json | null,
  ): CanonicalEvent {
    return canonicalEventSchema.parse({
      // Backfill has no delivery id, so the key is derived from the event's
      // identity. A webhook for the same fact produces the same row.
      idempotencyKey: eventIdempotencyKey({ provider: 'github', deliveryId: null, eventType: type, subjectId, occurredAt }),
      provider: 'github',
      deliveryId: null,
      type,
      occurredAt: new Date(occurredAt).toISOString(),
      receivedAt: new Date().toISOString(),
      orgSlug,
      repository: repo,
      actor: actor
        ? {
            providerUserId: numStr(actor.id) ?? '',
            login: s(actor.login) ?? 'unknown',
            name: s(actor.name),
            isBot: s(actor.type) === 'Bot' || (s(actor.login) ?? '').endsWith('[bot]'),
          }
        : null,
      payload,
    });
  }

  private prPayload(pr: Json): Json {
    return {
      providerPrId: numStr(pr.id) ?? '',
      number: typeof pr.number === 'number' ? pr.number : Number(pr.number),
      title: s(pr.title) ?? '',
      state: pr.merged_at ? 'merged' : s(pr.state) === 'closed' ? 'closed' : 'open',
      isDraft: pr.draft === true,
      baseBranch: s(obj(pr.base)?.ref) ?? 'main',
      headBranch: s(obj(pr.head)?.ref) ?? '',
      createdAt: s(pr.created_at),
      mergedAt: s(pr.merged_at),
      closedAt: s(pr.closed_at),
      additions: typeof pr.additions === 'number' ? pr.additions : 0,
      deletions: typeof pr.deletions === 'number' ? pr.deletions : 0,
      changedFiles: typeof pr.changed_files === 'number' ? pr.changed_files : 0,
      commitCount: typeof pr.commits === 'number' ? pr.commits : 0,
      mergeCommitSha: s(pr.merge_commit_sha),
    };
  }

  private prEvents(orgSlug: string, repo: RepoMeta, pr: Json): CanonicalEvent[] {
    const payload = this.prPayload(pr);
    const subject = numStr(pr.id) ?? '';
    const author = obj(pr.user);
    const events = [this.build(orgSlug, repo, 'pull_request.opened', s(pr.created_at) ?? new Date().toISOString(), subject, payload, author)];
    if (pr.merged_at) {
      events.push(this.build(orgSlug, repo, 'pull_request.merged', s(pr.merged_at) as string, subject, payload, author));
    } else if (pr.closed_at) {
      events.push(this.build(orgSlug, repo, 'pull_request.closed', s(pr.closed_at) as string, subject, payload, author));
    }
    return events;
  }

  private reviewEvent(orgSlug: string, repo: RepoMeta, pr: Json, review: Json): CanonicalEvent {
    const state = (s(review.state) ?? '').toLowerCase();
    return this.build(
      orgSlug, repo, 'review.submitted',
      s(review.submitted_at) ?? s(pr.updated_at) ?? new Date().toISOString(),
      numStr(review.id) ?? '',
      {
        providerReviewId: numStr(review.id) ?? '',
        state: state === 'approved' ? 'approved' : state === 'changes_requested' ? 'changes_requested' : state === 'dismissed' ? 'dismissed' : 'commented',
        submittedAt: s(review.submitted_at),
        pullRequest: this.prPayload(pr),
      },
      obj(review.user),
    );
  }

  private runEvent(orgSlug: string, repo: RepoMeta, run: Json): CanonicalEvent {
    const completed = s(run.status) === 'completed';
    const prs = Array.isArray(run.pull_requests) ? (run.pull_requests as Json[]) : [];
    return this.build(
      orgSlug, repo,
      completed ? 'workflow_run.completed' : 'workflow_run.started',
      s(run.updated_at) ?? s(run.created_at) ?? new Date().toISOString(),
      `${numStr(run.id)}:${typeof run.run_attempt === 'number' ? run.run_attempt : 1}`,
      {
        providerRunId: numStr(run.id) ?? '',
        runAttempt: typeof run.run_attempt === 'number' ? run.run_attempt : 1,
        headSha: s(run.head_sha) ?? '',
        headBranch: s(run.head_branch),
        event: s(run.event) ?? '',
        status: completed ? 'completed' : 'in_progress',
        conclusion: s(run.conclusion),
        createdAt: s(run.created_at),
        startedAt: s(run.run_started_at),
        completedAt: completed ? s(run.updated_at) : null,
        workflow: { providerWorkflowId: numStr(run.workflow_id) ?? '', name: s(run.name) ?? 'workflow', path: s(run.path) },
        pullRequestNumbers: prs.map((p) => Number(p.number)).filter(Number.isFinite),
      },
      obj(run.actor),
    );
  }

  private deploymentEvent(orgSlug: string, repo: RepoMeta, deployment: Json, status: Json | null): CanonicalEvent {
    const environment = s(deployment.environment) ?? 'unknown';
    const occurredAt = s(status?.updated_at) ?? s(deployment.created_at) ?? new Date().toISOString();
    return this.build(
      orgSlug, repo,
      status ? 'deployment.status_changed' : 'deployment.created',
      occurredAt,
      `${numStr(deployment.id)}:${numStr(status?.id) ?? 'created'}`,
      {
        providerDeploymentId: numStr(deployment.id) ?? '',
        environment,
        isProduction: /^(production|prod|live)$/i.test(environment) || deployment.production_environment === true,
        sha: s(deployment.sha) ?? '',
        state: s(status?.state) ?? 'pending',
        createdAt: s(deployment.created_at),
        completedAt: s(status?.updated_at),
      },
      obj(deployment.creator),
    );
  }
}

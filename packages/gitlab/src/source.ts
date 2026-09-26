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
import { parseGitLabTimestamp, parseGitLabTimestampOr } from './timestamps.js';

/**
 * GitLab REST and GraphQL backfill.
 *
 * Backfill emits the same canonical events as the webhook path and writes
 * through the same idempotent insert, so history and live traffic converge
 * where they overlap rather than double-counting.
 *
 * Backfill is strictly better-informed than the webhook here, which is unusual
 * and worth knowing:
 *
 *   - the REST merge request carries real `merged_at` and `closed_at`, which
 *     the webhook does not, so cycle time from backfill is exact rather than
 *     accurate-to-webhook-latency;
 *   - pipelines carry a real `started_at`, so CI queue time is measured rather
 *     than reconstructed from a queue duration;
 *   - deployments carry the full commit sha rather than an abbreviation;
 *   - diff statistics exist at all, via GraphQL `diffStatsSummary`, which is
 *     the only interface GitLab exposes them on.
 *
 * Approval history is reconstructed from system notes. GitLab's approvals
 * endpoint reports who approved but not when, and a timestamp is the entire
 * point for review latency.
 */

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface GitLabClientOptions {
  token: string;
  /** Instance root, e.g. https://gitlab.com or a self-managed host. */
  baseUrl?: string;
  fetchImpl?: FetchLike;
  onRateLimit?: (resetAtMs: number) => Promise<void>;
}

export class GitLabRateLimitError extends Error {
  constructor(readonly resetAtMs: number) {
    super(`GitLab rate limit exhausted; resets at ${new Date(resetAtMs).toISOString()}`);
    this.name = 'GitLabRateLimitError';
  }
}

type Json = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

export class GitLabClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  rateLimitRemaining: number | null = null;
  /** Next page number from GitLab's pagination headers, when there is one. */
  lastNextPage: number | null = null;

  constructor(private readonly opts: GitLabClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://gitlab.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  /** GitLab identifies projects by URL-encoded path, so every slash is escaped. */
  static projectId(repoFullName: string): string {
    return encodeURIComponent(repoFullName);
  }

  private headers(): Record<string, string> {
    return {
      // Server-side only. No GitLab token is ever returned by an API route or
      // reaches a browser.
      authorization: `Bearer ${this.opts.token}`,
      accept: 'application/json',
      'user-agent': 'devanalytics',
    };
  }

  private async handleRateLimit(res: { status: number; headers: { get(name: string): string | null } }): Promise<void> {
    const remaining = res.headers.get('ratelimit-remaining');
    this.rateLimitRemaining = remaining === null ? null : Number(remaining);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 0);
      const reset = Number(res.headers.get('ratelimit-reset') ?? 0) * 1000;
      const resetAt = reset > 0 ? reset : Date.now() + (retryAfter > 0 ? retryAfter : 60) * 1000;
      if (this.opts.onRateLimit) await this.opts.onRateLimit(resetAt);
      else throw new GitLabRateLimitError(resetAt);
    }
  }

  async get<T = unknown>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}/api/v4${path}`;
    const res = await this.fetchImpl(url, { headers: this.headers() });
    await this.handleRateLimit(res);
    const next = res.headers.get('x-next-page');
    this.lastNextPage = next && next.trim() !== '' ? Number(next) : null;
    if (!res.ok) throw new Error(`GitLab ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }

  async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/graphql`, {
      method: 'POST',
      headers: { ...this.headers(), 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    await this.handleRateLimit(res);
    if (!res.ok) throw new Error(`GitLab GraphQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (body.errors?.length) throw new Error(`GitLab GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
    return body.data as T;
  }
}

interface ProjectMeta {
  providerRepoId: string;
  fullName: string;
  name: string;
  defaultBranch: string;
  isPrivate: boolean;
}

const DIFF_STATS_QUERY = `
query DiffStats($fullPath: ID!, $iids: [String!]) {
  project(fullPath: $fullPath) {
    mergeRequests(iids: $iids, first: 100) {
      nodes { iid diffStatsSummary { additions deletions fileCount } }
    }
  }
}`;

export interface DiffStats {
  additions: number;
  deletions: number;
  changedFiles: number;
}

export class GitLabSource implements RepositorySource {
  readonly provider = 'gitlab' as const;

  constructor(private readonly client: GitLabClient) {}

  async projectMeta(repoFullName: string): Promise<ProjectMeta> {
    const p = await this.client.get<Json>(`/projects/${GitLabClient.projectId(repoFullName)}`);
    const path = s(p.path_with_namespace) ?? repoFullName;
    return {
      providerRepoId: String(n(p.id) ?? ''),
      fullName: path,
      name: path.split('/').pop() ?? path,
      defaultBranch: s(p.default_branch) ?? 'main',
      isPrivate: s(p.visibility) !== 'public',
    };
  }

  /**
   * Diff statistics for a page of merge requests, in one GraphQL round trip.
   *
   * GitLab exposes these nowhere in its REST API: the closest REST endpoint
   * returns raw diffs that would have to be parsed. Merge requests missing
   * from the response keep unknown sizes rather than gaining zeros.
   */
  async diffStats(repoFullName: string, iids: number[]): Promise<Map<number, DiffStats>> {
    const out = new Map<number, DiffStats>();
    if (iids.length === 0) return out;

    try {
      const data = await this.client.graphql<{
        project?: { mergeRequests?: { nodes?: { iid: string; diffStatsSummary?: { additions: number; deletions: number; fileCount: number } }[] } };
      }>(DIFF_STATS_QUERY, { fullPath: repoFullName, iids: iids.map(String) });

      for (const node of data.project?.mergeRequests?.nodes ?? []) {
        const summary = node.diffStatsSummary;
        const iid = Number(node.iid);
        if (!summary || !Number.isFinite(iid)) continue;
        out.set(iid, { additions: summary.additions, deletions: summary.deletions, changedFiles: summary.fileCount });
      }
    } catch {
      // A self-managed instance may have GraphQL disabled, or the token may
      // lack scope. Sizes then stay unknown, which the metric reports as an
      // exclusion rather than as zero-line merge requests.
      return out;
    }
    return out;
  }

  async backfill(input: {
    orgSlug: string;
    repoFullName: string;
    window: TimeWindow;
    cursor: BackfillCursor;
    pageSize: number;
  }): Promise<BackfillPage> {
    const page = input.cursor.token ? Number(input.cursor.token) : 1;
    const project = await this.projectMeta(input.repoFullName);
    const id = GitLabClient.projectId(input.repoFullName);

    const mergeRequests = await this.client.get<Json[]>(
      `/projects/${id}/merge_requests?scope=all&state=all&order_by=updated_at&sort=desc` +
        `&updated_after=${encodeURIComponent(input.window.from)}&per_page=${input.pageSize}&page=${page}`,
    );
    const nextPage = this.client.lastNextPage;

    const iids = mergeRequests.map((mr) => n(mr.iid)).filter((v): v is number => v !== null);
    const stats = await this.diffStats(input.repoFullName, iids);

    const events: CanonicalEvent[] = [];
    for (const mr of mergeRequests) {
      const iid = n(mr.iid);
      if (iid === null) continue;
      const size = stats.get(iid) ?? null;
      events.push(...this.mergeRequestEvents(input.orgSlug, project, mr, size));

      const notes = await this.client.get<Json[]>(
        `/projects/${id}/merge_requests/${iid}/notes?sort=asc&order_by=created_at&per_page=100`,
      );
      events.push(...this.noteEvents(input.orgSlug, project, mr, notes, size));
    }

    return {
      events,
      cursor: { token: nextPage === null ? null : String(nextPage), done: nextPage === null },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  async backfillPipelines(orgSlug: string, repoFullName: string, window: TimeWindow, page = 1, pageSize = 50): Promise<BackfillPage> {
    const project = await this.projectMeta(repoFullName);
    const id = GitLabClient.projectId(repoFullName);

    const list = await this.client.get<Json[]>(
      `/projects/${id}/pipelines?updated_after=${encodeURIComponent(window.from)}&order_by=updated_at&sort=desc&per_page=${pageSize}&page=${page}`,
    );
    const nextPage = this.client.lastNextPage;

    const events: CanonicalEvent[] = [];
    for (const summary of list) {
      const pipelineId = n(summary.id);
      if (pipelineId === null) continue;
      // The list endpoint omits timings; the detail endpoint carries
      // started_at and finished_at, which is what CI duration and queue time
      // are actually made of.
      const detail = await this.client.get<Json>(`/projects/${id}/pipelines/${pipelineId}`);
      const event = this.pipelineEvent(orgSlug, project, detail);
      if (event) events.push(event);
    }

    return {
      events,
      cursor: { token: nextPage === null ? null : String(nextPage), done: nextPage === null },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  async backfillDeployments(orgSlug: string, repoFullName: string, window: TimeWindow, page = 1, pageSize = 50): Promise<BackfillPage> {
    const project = await this.projectMeta(repoFullName);
    const id = GitLabClient.projectId(repoFullName);

    // Environment tiers are a deliberate declaration of what production means,
    // and beat guessing from a name like "prod-eu-west".
    const tiers = new Map<string, string>();
    try {
      for (const env of await this.client.get<Json[]>(`/projects/${id}/environments?per_page=100`)) {
        const name = s(env.name);
        const tier = s(env.tier);
        if (name && tier) tiers.set(name, tier);
      }
    } catch {
      // Older instances have no tiers; the name heuristic stands in.
    }

    const deployments = await this.client.get<Json[]>(
      `/projects/${id}/deployments?updated_after=${encodeURIComponent(window.from)}&order_by=created_at&sort=desc&per_page=${pageSize}&page=${page}`,
    );
    const nextPage = this.client.lastNextPage;

    const events = deployments
      .map((d) => this.deploymentEvent(orgSlug, project, d, tiers))
      .filter((e): e is CanonicalEvent => e !== null);

    return {
      events,
      cursor: { token: nextPage === null ? null : String(nextPage), done: nextPage === null },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  // ------------------------------------------------------------ builders --

  private build(
    orgSlug: string,
    project: ProjectMeta,
    type: CanonicalEventType,
    occurredAt: string,
    subjectId: string,
    payload: Json,
    actor: Json | null,
  ): CanonicalEvent {
    return canonicalEventSchema.parse({
      // Backfill has no delivery id, so the key is derived from the event's
      // identity. A webhook for the same fact produces the same row.
      idempotencyKey: eventIdempotencyKey({ provider: 'gitlab', deliveryId: null, eventType: type, subjectId, occurredAt }),
      provider: 'gitlab',
      deliveryId: null,
      type,
      occurredAt,
      receivedAt: new Date().toISOString(),
      orgSlug,
      repository: project,
      actor: actor
        ? {
            providerUserId: String(n(actor.id) ?? s(actor.username) ?? ''),
            login: s(actor.username) ?? 'unknown',
            name: s(actor.name),
            isBot: s(actor.user_type) === 'project_bot' || /(^|_)bot(_|$)|^project_\d+_bot/i.test(s(actor.username) ?? ''),
          }
        : null,
      payload,
    });
  }

  private mergeRequestPayload(mr: Json, size: DiffStats | null): Json {
    const state = s(mr.state) ?? 'opened';
    const createdAt = parseGitLabTimestampOr(mr.created_at, new Date().toISOString());
    return {
      providerPrId: String(n(mr.id) ?? ''),
      number: n(mr.iid) ?? 0,
      title: s(mr.title) ?? '',
      state: state === 'merged' ? 'merged' : state === 'closed' || state === 'locked' ? 'closed' : 'open',
      isDraft: mr.draft === true || mr.work_in_progress === true,
      baseBranch: s(mr.target_branch) ?? 'main',
      headBranch: s(mr.source_branch) ?? '',
      createdAt,
      // Unlike the webhook, the REST merge request reports these directly.
      mergedAt: parseGitLabTimestamp(mr.merged_at),
      closedAt: parseGitLabTimestamp(mr.closed_at) ?? parseGitLabTimestamp(mr.merged_at),
      mergeCommitSha: s(mr.merge_commit_sha) ?? s(mr.squash_commit_sha),
      // Present only when GraphQL supplied them; otherwise the key is absent
      // and the size stays unknown.
      ...(size ? { additions: size.additions, deletions: size.deletions, changedFiles: size.changedFiles } : {}),
    };
  }

  private mergeRequestEvents(orgSlug: string, project: ProjectMeta, mr: Json, size: DiffStats | null): CanonicalEvent[] {
    const payload = this.mergeRequestPayload(mr, size);
    const subject = String(n(mr.id) ?? '');
    const author = obj(mr.author);
    const events = [this.build(orgSlug, project, 'pull_request.opened', payload.createdAt as string, subject, payload, author)];

    const mergedAt = parseGitLabTimestamp(mr.merged_at);
    const closedAt = parseGitLabTimestamp(mr.closed_at);
    if (mergedAt) {
      events.push(this.build(orgSlug, project, 'pull_request.merged', mergedAt, subject, payload, obj(mr.merge_user) ?? author));
    } else if (closedAt) {
      events.push(this.build(orgSlug, project, 'pull_request.closed', closedAt, subject, payload, author));
    }
    return events;
  }

  /**
   * Reviews and review comments, reconstructed from notes.
   *
   * GitLab records an approval as a system note ("approved this merge
   * request") rather than as a first-class reviewable resource with a
   * timestamp. The approvals endpoint reports who approved but not when, and
   * "when" is the entire content of review latency.
   */
  private noteEvents(orgSlug: string, project: ProjectMeta, mr: Json, notes: Json[], size: DiffStats | null): CanonicalEvent[] {
    const prPayload = this.mergeRequestPayload(mr, size);
    const events: CanonicalEvent[] = [];

    for (const note of notes) {
      const noteId = n(note.id);
      if (noteId === null) continue;
      const createdAt = parseGitLabTimestamp(note.created_at);
      if (!createdAt) continue;
      const author = obj(note.author);

      if (note.system === true) {
        const body = (s(note.body) ?? '').toLowerCase();
        const approved = body.startsWith('approved this merge request');
        const unapproved = body.startsWith('unapproved this merge request');
        if (!approved && !unapproved) continue;
        events.push(
          this.build(orgSlug, project, 'review.submitted', createdAt, String(noteId), {
            providerReviewId: String(noteId),
            state: approved ? 'approved' : 'dismissed',
            submittedAt: createdAt,
            pullRequest: prPayload,
          }, author),
        );
        continue;
      }

      // Only inline diff comments are review comments, matching the webhook
      // path and GitHub's pull_request_review_comment.
      if (s(note.type) !== 'DiffNote') continue;
      const position = obj(note.position);
      events.push(
        this.build(orgSlug, project, 'review_comment.created', createdAt, String(noteId), {
          providerCommentId: String(noteId),
          reviewId: null,
          path: s(position?.new_path) ?? s(position?.old_path),
          body: s(note.body) ?? '',
          createdAt,
          pullRequest: prPayload,
        }, author),
      );
    }

    return events;
  }

  private pipelineEvent(orgSlug: string, project: ProjectMeta, pipeline: Json): CanonicalEvent | null {
    const pipelineId = n(pipeline.id);
    if (pipelineId === null) return null;

    const status = (s(pipeline.status) ?? '').toLowerCase();
    const terminal = ['success', 'failed', 'canceled', 'cancelled', 'skipped'].includes(status);
    if (!terminal && status !== 'running') return null;

    const createdAt = parseGitLabTimestampOr(pipeline.created_at, new Date().toISOString());
    const finishedAt = parseGitLabTimestamp(pipeline.finished_at);
    // The detail endpoint reports a real start time, so queue time is measured
    // rather than reconstructed from a duration.
    const startedAt = parseGitLabTimestamp(pipeline.started_at);

    const conclusion =
      status === 'success' ? 'success'
      : status === 'failed' ? 'failure'
      : status === 'canceled' || status === 'cancelled' ? 'cancelled'
      : status === 'skipped' ? 'skipped'
      : null;

    return this.build(
      orgSlug, project,
      terminal ? 'workflow_run.completed' : 'workflow_run.started',
      terminal ? (finishedAt ?? createdAt) : createdAt,
      String(pipelineId),
      {
        providerRunId: String(pipelineId),
        runAttempt: 1,
        headSha: s(pipeline.sha) ?? '',
        headBranch: s(pipeline.ref),
        event: s(pipeline.source) ?? '',
        status: terminal ? 'completed' : 'in_progress',
        conclusion: terminal ? conclusion : null,
        createdAt,
        startedAt,
        completedAt: terminal ? finishedAt : null,
        workflow: { providerWorkflowId: 'gitlab-ci', name: 'GitLab CI', path: '.gitlab-ci.yml' },
        pullRequestNumbers: [],
      },
      obj(pipeline.user),
    );
  }

  private deploymentEvent(orgSlug: string, project: ProjectMeta, deployment: Json, tiers: Map<string, string>): CanonicalEvent | null {
    const deploymentId = n(deployment.id);
    if (deploymentId === null) return null;

    const environment = obj(deployment.environment);
    const environmentName = s(environment?.name) ?? 'unknown';
    const tier = s(environment?.tier) ?? tiers.get(environmentName) ?? null;
    const status = (s(deployment.status) ?? '').toLowerCase();
    const createdAt = parseGitLabTimestampOr(deployment.created_at, new Date().toISOString());
    const updatedAt = parseGitLabTimestamp(deployment.updated_at);

    const state =
      status === 'success' ? 'success'
      : status === 'failed' ? 'failure'
      : status === 'running' ? 'in_progress'
      : status === 'canceled' || status === 'cancelled' ? 'inactive'
      : 'pending';

    const deployable = obj(deployment.deployable);
    const commit = obj(deployable?.commit);

    return this.build(
      orgSlug, project, 'deployment.status_changed', updatedAt ?? createdAt,
      `${deploymentId}:${status}`,
      {
        providerDeploymentId: String(deploymentId),
        environment: environmentName,
        isProduction: tier === 'production' || /^(production|prod|live)$/i.test(environmentName),
        // The deployments API reports the full sha, unlike the webhook.
        sha: s(deployment.sha) ?? s(commit?.id) ?? '',
        state,
        createdAt,
        completedAt: state === 'success' || state === 'failure' ? (updatedAt ?? createdAt) : null,
      },
      obj(deployment.user),
    );
  }
}

/** Commit authors, for attributing pushed commits during backfill. */
export async function resolveCommitAuthors(
  client: GitLabClient,
  repoFullName: string,
  window: TimeWindow,
  page = 1,
  pageSize = 100,
): Promise<{ commits: Json[]; nextPage: number | null }> {
  const id = GitLabClient.projectId(repoFullName);
  const commits = await client.get<Json[]>(
    `/projects/${id}/repository/commits?since=${encodeURIComponent(window.from)}&until=${encodeURIComponent(window.to)}` +
      `&per_page=${pageSize}&page=${page}&with_stats=true`,
  );
  return { commits: arr(commits), nextPage: client.lastNextPage };
}

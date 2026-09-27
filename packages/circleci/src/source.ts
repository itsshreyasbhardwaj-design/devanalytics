import {
  canonicalEventSchema,
  eventIdempotencyKey,
  type BackfillCursor,
  type BackfillPage,
  type CanonicalEvent,
  type RepositorySource,
  type TimeWindow,
} from '@devanalytics/core';
import { resolveRepositoryRef, type RepositoryRef } from './project.js';

/**
 * CircleCI API v2 backfill.
 *
 * Emits the same canonical events as the webhook path, through the same
 * idempotent insert, so history and live traffic converge where they overlap.
 *
 * Unlike GitLab, backfill here is no better informed than the webhook: the API
 * reports the same workflow created/stopped pair and no runner wait, so CI
 * queue time stays unavailable for CircleCI either way. What backfill adds is
 * reach — history from before the webhook was wired up.
 */

export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface CircleCiClientOptions {
  token: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  onRateLimit?: (resetAtMs: number) => Promise<void>;
}

export class CircleCiRateLimitError extends Error {
  constructor(readonly resetAtMs: number) {
    super(`CircleCI rate limit exhausted; resets at ${new Date(resetAtMs).toISOString()}`);
    this.name = 'CircleCiRateLimitError';
  }
}

type Json = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null);
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

const iso = (v: unknown): string | null => {
  const raw = s(v);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const TERMINAL = new Set(['success', 'failed', 'error', 'failing', 'canceled', 'cancelled', 'unauthorized']);

function conclusionFor(status: string): string | null {
  switch (status) {
    case 'success': return 'success';
    case 'failed':
    case 'failing':
    case 'error': return 'failure';
    case 'canceled':
    case 'cancelled': return 'cancelled';
    case 'unauthorized': return 'action_required';
    default: return null;
  }
}

export class CircleCiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  rateLimitRemaining: number | null = null;

  constructor(private readonly opts: CircleCiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? 'https://circleci.com').replace(/\/$/, '');
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async get<T = unknown>(path: string): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}/api/v2${path}`;
    const res = await this.fetchImpl(url, {
      headers: {
        // Server-side only; no CircleCI token reaches a browser.
        'circle-token': this.opts.token,
        accept: 'application/json',
        'user-agent': 'devanalytics',
      },
    });

    const remaining = res.headers.get('x-ratelimit-remaining');
    this.rateLimitRemaining = remaining === null ? null : Number(remaining);

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? 60);
      const resetAt = Date.now() + retryAfter * 1000;
      if (this.opts.onRateLimit) await this.opts.onRateLimit(resetAt);
      else throw new CircleCiRateLimitError(resetAt);
    }
    if (!res.ok) throw new Error(`CircleCI ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

export class CircleCiSource implements RepositorySource {
  readonly provider = 'circleci' as const;

  constructor(private readonly client: CircleCiClient) {}

  /**
   * Backfill by CircleCI project slug.
   *
   * `repoFullName` is the CircleCI project slug (`gh/acme/api`), not the code
   * host path, because that is what the API addresses projects by. The
   * repository the events resolve to is derived from it exactly as the webhook
   * adapter derives it.
   */
  async backfill(input: {
    orgSlug: string;
    repoFullName: string;
    window: TimeWindow;
    cursor: BackfillCursor;
    pageSize: number;
  }): Promise<BackfillPage> {
    const projectSlug = input.repoFullName;
    const pageToken = input.cursor.token;

    const pipelines = await this.client.get<{ items?: Json[]; next_page_token?: string | null }>(
      `/project/${encodeURIComponent(projectSlug)}/pipeline${pageToken ? `?page-token=${encodeURIComponent(pageToken)}` : ''}`,
    );

    const events: CanonicalEvent[] = [];
    let reachedWindowStart = false;

    for (const pipeline of arr(pipelines.items)) {
      const createdAt = iso(pipeline.created_at);
      if (createdAt && new Date(createdAt) < new Date(input.window.from)) {
        // Pipelines come back newest first, so once we pass the window there
        // is nothing older worth fetching.
        reachedWindowStart = true;
        continue;
      }
      const pipelineId = s(pipeline.id);
      if (!pipelineId || !createdAt) continue;

      const ref = resolveRepositoryRef({
        repositoryUrl: s(obj(pipeline.vcs)?.target_repository_url) ?? s(obj(pipeline.vcs)?.origin_repository_url),
        vcsName: s(obj(pipeline.vcs)?.provider_name),
        projectSlug: s(pipeline.project_slug) ?? projectSlug,
      });
      if (!ref) continue;

      const workflows = await this.client.get<{ items?: Json[] }>(`/pipeline/${encodeURIComponent(pipelineId)}/workflow`);
      for (const workflow of arr(workflows.items)) {
        const event = this.workflowEvent(input.orgSlug, ref, pipeline, workflow, createdAt);
        if (event) events.push(event);
      }
    }

    const next = pipelines.next_page_token ?? null;
    return {
      events,
      cursor: { token: next, done: next === null || reachedWindowStart },
      rateLimitRemaining: this.client.rateLimitRemaining,
    };
  }

  private workflowEvent(
    orgSlug: string,
    ref: RepositoryRef,
    pipeline: Json,
    workflow: Json,
    pipelineCreatedAt: string,
  ): CanonicalEvent | null {
    const workflowId = s(workflow.id);
    if (!workflowId) return null;

    const status = (s(workflow.status) ?? '').toLowerCase();
    const terminal = TERMINAL.has(status);
    if (!terminal && status !== 'running') return null;

    const startedAt = iso(workflow.created_at);
    const stoppedAt = iso(workflow.stopped_at);
    const occurredAt = terminal ? (stoppedAt ?? pipelineCreatedAt) : (startedAt ?? pipelineCreatedAt);
    const vcs = obj(pipeline.vcs);

    return canonicalEventSchema.parse({
      idempotencyKey: eventIdempotencyKey({
        provider: 'circleci',
        deliveryId: null,
        eventType: terminal ? 'workflow_run.completed' : 'workflow_run.started',
        subjectId: workflowId,
        occurredAt,
      }),
      provider: 'circleci',
      deliveryId: null,
      type: terminal ? 'workflow_run.completed' : 'workflow_run.started',
      occurredAt,
      receivedAt: new Date().toISOString(),
      orgSlug,
      repository: {
        providerRepoId: ref.fullName,
        fullName: ref.fullName,
        name: ref.fullName.split('/').pop() ?? ref.fullName,
        defaultBranch: 'main',
        isPrivate: true,
        provider: ref.hostProvider,
        isReference: true,
      },
      actor: null,
      payload: {
        providerRunId: workflowId,
        runAttempt: 1,
        headSha: s(vcs?.revision) ?? '',
        headBranch: s(vcs?.branch) ?? (s(vcs?.tag) ? `refs/tags/${s(vcs?.tag)}` : null),
        event: s(obj(pipeline.trigger)?.type) ?? '',
        status: terminal ? 'completed' : 'in_progress',
        conclusion: terminal ? conclusionFor(status) : null,
        createdAt: pipelineCreatedAt,
        // The API reports no runner wait either, so backfilled CircleCI runs
        // are excluded from CI queue time exactly as live ones are.
        enqueuedAt: null,
        startedAt,
        completedAt: terminal ? stoppedAt : null,
        workflow: {
          providerWorkflowId: s(workflow.name) ?? 'workflow',
          name: s(workflow.name) ?? 'workflow',
          path: '.circleci/config.yml',
        },
        pullRequestNumbers: [],
        pipelineNumber: num(pipeline.number),
      },
    });
  }
}

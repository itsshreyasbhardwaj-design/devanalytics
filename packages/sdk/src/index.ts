/**
 * DevAnalytics TypeScript SDK.
 *
 * A thin, fully-typed client over the REST API. It deliberately does not
 * normalise `insufficient_data` away: a caller has to handle the sum type, so
 * a chart built on this SDK cannot accidentally plot a missing period as zero.
 *
 *   const client = new DevAnalytics({ apiKey: process.env.DEVANALYTICS_API_KEY });
 *   const cycle = await client.metrics.get('pr_cycle_time', { period: '30d' });
 *   if (cycle.result.status === 'ok') console.log(cycle.result.value);
 */

export type MetricStatus = 'ok' | 'insufficient_data';

export interface MetricOkResult {
  status: 'ok';
  value: number;
  sampleSize: number;
}
export interface MetricInsufficientResult {
  status: 'insufficient_data';
  reason: 'no_data' | 'below_minimum_sample' | 'no_baseline' | 'metric_not_supported_for_scope';
  sampleSize: number;
  minimumSampleSize: number;
}
export type MetricResultDto = MetricOkResult | MetricInsufficientResult;

export type ScopeType = 'org' | 'repository' | 'team' | 'branch' | 'developer';
export type Granularity = 'day' | 'week' | 'month';
export type Period = '1d' | '7d' | '30d' | '90d' | '365d';
export type Dimension = 'repository' | 'team' | 'branch' | 'author';

export interface MetricDefinitionDto {
  id: string;
  name: string;
  description: string;
  formula: string;
  dataSource: string[];
  unit: string;
  aggregation: string;
  direction: 'lower_is_better' | 'higher_is_better' | 'neutral';
  timeAnchor: string;
  minimumSampleSize: number;
  supportedScopes: ScopeType[];
  appliedFilters: string[];
  caveats: string[];
}

export interface QueryOptions {
  scopeType?: ScopeType;
  scopeId?: string;
  period?: Period;
  from?: string;
  to?: string;
  granularity?: Granularity;
  repositoryId?: string | string[];
  teamId?: string | string[];
  branch?: string | string[];
  authorUserId?: string | string[];
  excludeBots?: boolean;
  productionOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface MetricValueDto {
  metric: string;
  definition: MetricDefinitionDto;
  scopeType: ScopeType;
  scopeId: string;
  window: { from: string; to: string };
  result: MetricResultDto;
  numerator: number | null;
  denominator: number | null;
  excluded?: { count: number; reason: string };
}

export interface SeriesResponse {
  granularity: Granularity;
  window: { from: string; to: string };
  points: { bucketStart: string; result: MetricResultDto; numerator: number | null; denominator: number | null }[];
}

export interface ComparisonResponse {
  current: MetricValueDto;
  previous: MetricValueDto;
  comparison: {
    absoluteChange: number | null;
    relativeChange: number | null;
    direction: 'up' | 'down' | 'flat' | 'unknown';
  };
  previousWindow: { from: string; to: string };
}

export interface BreakdownResponse {
  dimension: Dimension;
  rows: { key: string; label: string; result: MetricResultDto; numerator: number | null; denominator: number | null }[];
}

export interface RepositoryDto {
  id: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  teamId: string | null;
  openPullRequests: number;
  mergedLast30d: number;
}

export interface PullRequestDto {
  id: string;
  number: number;
  title: string;
  repoFullName: string;
  authorLogin: string | null;
  state: 'open' | 'closed' | 'merged';
  createdAt: string;
  readyForReviewAt: string | null;
  firstReviewAt: string | null;
  mergedAt: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface AnomalyDto {
  id: string;
  metric: string;
  scope_type: ScopeType;
  scope_id: string;
  scope_label: string;
  observed_value: number;
  baseline_value: number;
  score: number;
  direction: 'increase' | 'decrease';
  severity: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  sample_size: number;
  baseline_sample_size: number;
  status: 'open' | 'acknowledged' | 'resolved';
  detected_at: string;
}

export interface PlanDto {
  orgId: string;
  intent: 'metric_value' | 'metric_trend' | 'investigate' | 'contributors' | 'failure_patterns' | 'records' | 'unknown';
  metric: string | null;
  scopeType: ScopeType;
  scopeId: string | null;
  scopeHint: string | null;
  window: { from: string; to: string };
  period: Period | null;
  dimension: Dimension | null;
  interpretation: string;
  confidence: 'high' | 'medium' | 'low';
  unresolved: string[];
}

export interface AnswerDto {
  question: string;
  interpretation: string;
  answer: string;
  citations: {
    id: string; kind: string; metric: string | null; scope: string;
    window: { from: string; to: string }; statement: string; values: number[];
    sampleSize: number; href: string | null;
  }[];
  generatedBy: 'deterministic' | 'model';
  model: string | null;
  grounding: { grounded: boolean; unsupported: number[]; checked: number };
  modelRejected: { reason: string; unsupported: number[] } | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
  insufficientData: boolean;
  /** How the question was understood, before any data was read. */
  plan: PlanDto;
}

export class DevAnalyticsError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DevAnalyticsError';
  }
}

export interface DevAnalyticsOptions {
  /** API token, e.g. dva_abcd1234_... */
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Retries on 429 and 5xx, honouring Retry-After. Default 2. */
  maxRetries?: number;
  timeoutMs?: number;
}

export class DevAnalytics {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  readonly metrics: MetricsResource;
  readonly repositories: RepositoriesResource;
  readonly pullRequests: PullRequestsResource;
  readonly ci: CiResource;
  readonly deployments: DeploymentsResource;
  readonly anomalies: AnomaliesResource;
  readonly investigations: InvestigationsResource;
  readonly events: EventsResource;
  readonly ai: AiResource;

  constructor(private readonly options: DevAnalyticsOptions) {
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3117').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxRetries = options.maxRetries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30_000;

    this.metrics = new MetricsResource(this);
    this.repositories = new RepositoriesResource(this);
    this.pullRequests = new PullRequestsResource(this);
    this.ci = new CiResource(this);
    this.deployments = new DeploymentsResource(this);
    this.anomalies = new AnomaliesResource(this);
    this.investigations = new InvestigationsResource(this);
    this.events = new EventsResource(this);
    this.ai = new AiResource(this);
  }

  /** @internal */
  async request<T>(method: string, path: string, opts: { query?: Record<string, unknown>; body?: unknown } = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries((opts.query ?? {}) as Record<string, unknown>)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value)) for (const v of value) url.searchParams.append(key, String(v));
      else url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(url.toString(), {
          method,
          headers: {
            authorization: `Bearer ${this.options.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
          signal: controller.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get('retry-after') ?? 0);
          lastError = await toError(res);
          if (attempt < this.maxRetries) {
            await sleep(retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 250);
            continue;
          }
          throw lastError;
        }
        if (!res.ok) throw await toError(res);

        const payload = (await res.json()) as { data?: T } & Record<string, unknown>;
        return (payload.data ?? (payload as unknown)) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof DevAnalyticsError) throw err;
        if (attempt >= this.maxRetries) throw err;
        await sleep(2 ** attempt * 250);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Request failed');
  }
}

async function toError(res: Response): Promise<DevAnalyticsError> {
  let code = 'http_error';
  let message = `HTTP ${res.status}`;
  let detail: unknown;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; detail?: unknown } };
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      detail = body.error.detail;
    }
  } catch {
    // Non-JSON error body; the status is all we have.
  }
  return new DevAnalyticsError(message, res.status, code, detail);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class MetricsResource {
  constructor(private readonly client: DevAnalytics) {}

  /** Every metric definition: formula, data source, time anchor, caveats. */
  list(): Promise<{ metrics: MetricDefinitionDto[] }> {
    return this.client.request('GET', '/api/v1/metrics');
  }

  definition(metric: string): Promise<MetricDefinitionDto> {
    return this.client.request('GET', `/api/v1/metrics/${metric}`);
  }

  get(metric: string, query: QueryOptions = {}): Promise<MetricValueDto> {
    return this.client.request('GET', `/api/v1/metrics/${metric}/value`, { query: query as Record<string, unknown> });
  }

  compare(metric: string, query: QueryOptions = {}): Promise<ComparisonResponse> {
    return this.client.request('GET', `/api/v1/metrics/${metric}/compare`, { query: query as Record<string, unknown> });
  }

  series(metric: string, query: QueryOptions = {}): Promise<SeriesResponse> {
    return this.client.request('GET', `/api/v1/metrics/${metric}/series`, { query: query as Record<string, unknown> });
  }

  breakdown(metric: string, dimension: Dimension, query: QueryOptions = {}): Promise<BreakdownResponse> {
    return this.client.request('GET', `/api/v1/metrics/${metric}/breakdown`, { query: { ...query, dimension } as Record<string, unknown> });
  }

  /** The individual observations behind a value. */
  facts(metric: string, query: QueryOptions = {}): Promise<{ facts: { ts: string; val: number | null }[] }> {
    return this.client.request('GET', `/api/v1/metrics/${metric}/facts`, { query: query as Record<string, unknown> });
  }
}

class RepositoriesResource {
  constructor(private readonly client: DevAnalytics) {}
  list(): Promise<{ repositories: RepositoryDto[] }> {
    return this.client.request('GET', '/api/v1/repositories');
  }
  health(repositoryId: string, query: QueryOptions = {}): Promise<unknown> {
    return this.client.request('GET', `/api/v1/repositories/${repositoryId}/health`, { query: query as Record<string, unknown> });
  }
}

class PullRequestsResource {
  constructor(private readonly client: DevAnalytics) {}
  list(query: QueryOptions & { state?: string } = {}): Promise<{ pullRequests: PullRequestDto[] }> {
    return this.client.request('GET', '/api/v1/pull-requests', { query: query as Record<string, unknown> });
  }
  get(id: string): Promise<unknown> {
    return this.client.request('GET', `/api/v1/pull-requests/${id}`);
  }
}

class CiResource {
  constructor(private readonly client: DevAnalytics) {}
  runs(query: QueryOptions & { conclusion?: string } = {}): Promise<{ runs: unknown[] }> {
    return this.client.request('GET', '/api/v1/ci/runs', { query: query as Record<string, unknown> });
  }
}

class DeploymentsResource {
  constructor(private readonly client: DevAnalytics) {}
  list(query: QueryOptions = {}): Promise<{ deployments: unknown[] }> {
    return this.client.request('GET', '/api/v1/deployments', { query: query as Record<string, unknown> });
  }
}

class AnomaliesResource {
  constructor(private readonly client: DevAnalytics) {}
  list(query: QueryOptions & { status?: string; metric?: string } = {}): Promise<{ anomalies: AnomalyDto[] }> {
    return this.client.request('GET', '/api/v1/anomalies', { query: query as Record<string, unknown> });
  }
  acknowledge(id: string): Promise<{ id: string; status: string }> {
    return this.client.request('POST', `/api/v1/anomalies/${id}/acknowledge`);
  }
  detect(query: { granularity?: Granularity } = {}): Promise<unknown> {
    return this.client.request('POST', '/api/v1/anomalies/detect', { query: query as Record<string, unknown> });
  }
}

class InvestigationsResource {
  constructor(private readonly client: DevAnalytics) {}
  list(): Promise<{ investigations: unknown[] }> {
    return this.client.request('GET', '/api/v1/investigations');
  }
  get(id: string): Promise<unknown> {
    return this.client.request('GET', `/api/v1/investigations/${id}`);
  }
  create(input: { metric: string; scopeType?: ScopeType; scopeId?: string; anomalyId?: string }, query: QueryOptions = {}): Promise<unknown> {
    return this.client.request('POST', '/api/v1/investigations', { query: query as Record<string, unknown>, body: input });
  }
}

class EventsResource {
  constructor(private readonly client: DevAnalytics) {}
  list(query: QueryOptions & { type?: string } = {}): Promise<{ events: unknown[] }> {
    return this.client.request('GET', '/api/v1/events', { query: query as Record<string, unknown> });
  }
}

class AiResource {
  constructor(private readonly client: DevAnalytics) {}
  /** Ask a question; the answer cites the evidence it was computed from. */
  query(question: string): Promise<AnswerDto> {
    return this.client.request('POST', '/api/v1/ai/query', { body: { question } });
  }
  /** Run a guarded read-only SELECT. */
  sql(sql: string, maxRows?: number): Promise<{ rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; elapsedMs: number }> {
    return this.client.request('POST', '/api/v1/ai/sql', { body: { sql, maxRows } });
  }
}

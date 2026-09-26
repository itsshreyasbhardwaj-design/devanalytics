import type { ScopeType } from '@devanalytics/core';

/**
 * The metric registry is the single source of truth.
 *
 * METRICS.md is generated from this file (`pnpm docs:metrics`), the API
 * exposes it verbatim at /api/v1/metrics, and the AI layer is only allowed to
 * reference metrics that appear here. A metric that is not defined here cannot
 * be computed, cited or charted anywhere in the product.
 */

export type MetricUnit = 'hours' | 'minutes' | 'lines' | 'count' | 'ratio' | 'per_day' | 'count_per_pr';

/**
 * How a metric combines across buckets.
 *
 * - `mean`       value = sum(numerator) / sum(denominator); aggregatable
 * - `rate`       value = matching / total; aggregatable
 * - `per_day`    value = count / days in window; aggregatable
 * - `median`     value = percentile_cont(0.5); NOT aggregatable from buckets,
 *                so window values are recomputed from raw rows rather than
 *                averaged from daily snapshots, which would be wrong.
 */
export type Aggregation = 'mean' | 'rate' | 'per_day' | 'median';

export type MetricDirection = 'lower_is_better' | 'higher_is_better' | 'neutral';

export interface MetricDefinition {
  id: string;
  name: string;
  /** One sentence a non-analyst can act on. */
  description: string;
  /** The exact arithmetic, in terms of stored columns. */
  formula: string;
  /** Tables the value is derived from. */
  dataSource: string[];
  unit: MetricUnit;
  aggregation: Aggregation;
  direction: MetricDirection;
  /** Which column places a record in a time bucket. Stated because it is the most common source of disagreement between tools. */
  timeAnchor: string;
  /** Records required before a value is reported at all. Below this we return `insufficient_data`. */
  minimumSampleSize: number;
  supportedScopes: ScopeType[];
  /** Filters that meaningfully change this metric. Documented so nobody compares two differently-filtered numbers. */
  appliedFilters: string[];
  /** Assumptions a reader must know to trust the number. */
  caveats: string[];
}

const ALL_SCOPES: ScopeType[] = ['org', 'repository', 'team', 'branch', 'developer'];
const NO_DEVELOPER: ScopeType[] = ['org', 'repository', 'team', 'branch'];
const REPO_LEVEL: ScopeType[] = ['org', 'repository', 'team'];

const COMMON_FILTERS = ['repositoryIds', 'teamIds', 'branches', 'excludeBots'];

export const METRIC_DEFINITIONS: Record<string, MetricDefinition> = {
  pr_cycle_time: {
    id: 'pr_cycle_time',
    name: 'PR cycle time',
    description: 'How long a pull request takes from the moment it is ready for review until it is merged.',
    formula: 'median(merged_at - ready_for_review_at) over pull requests merged in the window',
    dataSource: ['pull_requests'],
    unit: 'hours',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'pull_requests.merged_at',
    minimumSampleSize: 5,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: [
      'Only merged pull requests contribute. Closed-without-merge PRs are excluded because they have no end state to measure to.',
      'The clock starts at ready_for_review_at, not created_at, so time spent in draft is not counted against the reviewer.',
      'Time is wall-clock, including nights and weekends. No working-hours calendar is assumed.',
    ],
  },
  pr_cycle_time_mean: {
    id: 'pr_cycle_time_mean',
    name: 'PR cycle time (mean)',
    description: 'Arithmetic mean of PR cycle time. Published alongside the median because it is aggregatable and therefore cheap over long windows.',
    formula: 'sum(merged_at - ready_for_review_at) / count(merged pull requests)',
    dataSource: ['pull_requests'],
    unit: 'hours',
    aggregation: 'mean',
    direction: 'lower_is_better',
    timeAnchor: 'pull_requests.merged_at',
    minimumSampleSize: 5,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: ['Sensitive to a single very old PR being merged. Prefer the median for reporting; use the mean for decomposition arithmetic.'],
  },
  time_to_first_review: {
    id: 'time_to_first_review',
    name: 'Time to first review',
    description: 'How long a pull request waits before any reviewer responds.',
    formula: 'median(first_review_at - ready_for_review_at) over pull requests that received a review in the window',
    dataSource: ['pull_requests', 'reviews'],
    unit: 'hours',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'pull_requests.first_review_at',
    minimumSampleSize: 5,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: [
      'Pull requests that never received a review are excluded, so a rising review backlog can *lower* this metric. Read it next to review participation.',
      'Self-reviews are excluded.',
    ],
  },
  review_turnaround_time: {
    id: 'review_turnaround_time',
    name: 'Review turnaround time',
    description: 'How long an individual reviewer takes to respond once review is requested.',
    formula: 'median(review.submitted_at - coalesce(review.requested_at, pull_request.ready_for_review_at)) over reviews submitted in the window',
    dataSource: ['reviews', 'pull_requests'],
    unit: 'hours',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'reviews.submitted_at',
    minimumSampleSize: 5,
    supportedScopes: ALL_SCOPES,
    appliedFilters: COMMON_FILTERS,
    caveats: [
      'Measured per review, not per pull request: a PR with three reviewers contributes three observations.',
      'When the host does not report a review request timestamp, the PR ready time is used instead, which overstates turnaround for reviewers added late.',
    ],
  },
  merge_time: {
    id: 'merge_time',
    name: 'Merge time',
    description: 'How long an approved pull request waits before it is actually merged.',
    formula: 'median(merged_at - first_approval_at) over pull requests merged in the window that had an approval',
    dataSource: ['pull_requests'],
    unit: 'hours',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'pull_requests.merged_at',
    minimumSampleSize: 5,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: [
      'Pull requests merged without an approval are excluded. In repositories that do not require review this metric covers very few PRs — check the sample size.',
      'Often dominated by required status checks rather than human delay; compare against build duration.',
    ],
  },
  pr_size: {
    id: 'pr_size',
    name: 'PR size',
    description: 'Lines changed per pull request. The single strongest correlate of slow review in most repositories.',
    formula: 'median(additions + deletions) over pull requests opened in the window',
    dataSource: ['pull_requests'],
    unit: 'lines',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'pull_requests.created_at',
    minimumSampleSize: 5,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: [
      'Counts every changed line, including generated files and lockfiles, unless the host reported them separately.',
      'Anchored on creation, not merge, so it describes what the team is *sending* for review in the window.',
    ],
  },
  deployment_frequency: {
    id: 'deployment_frequency',
    name: 'Deployment frequency',
    description: 'Successful production deployments per day. One of the four DORA metrics.',
    formula: 'count(successful production deployments) / days in window',
    dataSource: ['deployments'],
    unit: 'per_day',
    aggregation: 'per_day',
    direction: 'higher_is_better',
    timeAnchor: 'deployments.created_at',
    minimumSampleSize: 1,
    supportedScopes: REPO_LEVEL,
    appliedFilters: ['repositoryIds', 'teamIds', 'productionOnly'],
    caveats: [
      'Only environments marked production count. Staging and preview deployments are ingested but excluded here.',
      'A deployment that failed and was retried counts once, on success.',
    ],
  },
  lead_time_for_changes: {
    id: 'lead_time_for_changes',
    name: 'Lead time for changes',
    description: 'How long a commit takes to reach production. One of the four DORA metrics.',
    formula: 'median(deployment.created_at - first commit authored_at on the pull request) over production deployments in the window',
    dataSource: ['deployments', 'pull_requests', 'commits'],
    unit: 'hours',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'deployments.created_at',
    minimumSampleSize: 3,
    supportedScopes: REPO_LEVEL,
    appliedFilters: ['repositoryIds', 'teamIds', 'productionOnly'],
    caveats: [
      'Requires deployments to be linked to a pull request. Deployments with no linked PR are excluded, and the exclusion count is reported alongside the value.',
      'Uses the earliest commit on the pull request, so long-lived branches inflate this metric by design — that is the signal, not an error.',
    ],
  },
  build_success_rate: {
    id: 'build_success_rate',
    name: 'Build success rate',
    description: 'Share of completed CI runs that succeeded.',
    formula: 'count(runs with conclusion = success) / count(runs with conclusion in (success, failure, timed_out))',
    dataSource: ['workflow_runs'],
    unit: 'ratio',
    aggregation: 'rate',
    direction: 'higher_is_better',
    timeAnchor: 'workflow_runs.completed_at',
    minimumSampleSize: 20,
    supportedScopes: NO_DEVELOPER,
    appliedFilters: ['repositoryIds', 'teamIds', 'branches'],
    caveats: [
      'Cancelled and skipped runs are excluded from both numerator and denominator: they carry no signal about whether the build works.',
      'Each retry is a separate run, so a flaky job that passes on attempt 3 lowers this rate. That is intentional.',
    ],
  },
  build_duration: {
    id: 'build_duration',
    name: 'Build duration',
    description: 'How long CI takes once a runner picks the job up.',
    formula: 'median(completed_at - started_at) over completed CI runs in the window',
    dataSource: ['workflow_runs'],
    unit: 'minutes',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'workflow_runs.completed_at',
    minimumSampleSize: 20,
    supportedScopes: NO_DEVELOPER,
    appliedFilters: ['repositoryIds', 'teamIds', 'branches'],
    caveats: ['Excludes queue time, which is reported separately as CI queue time. A slow pipeline and a starved runner pool look identical if the two are added together.'],
  },
  ci_queue_time: {
    id: 'ci_queue_time',
    name: 'CI queue time',
    description: 'How long CI runs wait for a runner before starting.',
    formula: 'median(started_at - created_at) over CI runs started in the window',
    dataSource: ['workflow_runs'],
    unit: 'minutes',
    aggregation: 'median',
    direction: 'lower_is_better',
    timeAnchor: 'workflow_runs.created_at',
    minimumSampleSize: 20,
    supportedScopes: NO_DEVELOPER,
    appliedFilters: ['repositoryIds', 'teamIds', 'branches'],
    caveats: ['Rising queue time with flat build duration points at runner capacity, not at the pipeline.'],
  },
  failed_deployment_rate: {
    id: 'failed_deployment_rate',
    name: 'Failed deployment rate',
    description: 'Share of production deployments that ended in failure. Related to, but not identical to, the DORA change failure rate.',
    formula: 'count(production deployments in state failure or error) / count(production deployments)',
    dataSource: ['deployments'],
    unit: 'ratio',
    aggregation: 'rate',
    direction: 'lower_is_better',
    timeAnchor: 'deployments.created_at',
    minimumSampleSize: 10,
    supportedScopes: REPO_LEVEL,
    appliedFilters: ['repositoryIds', 'teamIds', 'productionOnly'],
    caveats: [
      'Measures deployment mechanics failing, not incidents caused by a successful deployment. It is a lower bound on change failure rate, never a substitute.',
    ],
  },
  reopened_pr_rate: {
    id: 'reopened_pr_rate',
    name: 'Reopened PR rate',
    description: 'Share of closed pull requests that had to be reopened at least once.',
    formula: 'count(pull requests with reopened_count > 0) / count(pull requests closed or merged in the window)',
    dataSource: ['pull_requests'],
    unit: 'ratio',
    aggregation: 'rate',
    direction: 'lower_is_better',
    timeAnchor: 'coalesce(pull_requests.merged_at, pull_requests.closed_at)',
    minimumSampleSize: 20,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: ['Reopening is a weak proxy for rework and is used very differently between teams. Compare a repository against its own history, not against another repository.'],
  },
  review_participation: {
    id: 'review_participation',
    name: 'Review participation',
    description: 'Distinct reviewers per merged pull request.',
    formula: 'count(distinct reviewers) / count(merged pull requests) over the window',
    dataSource: ['reviews', 'pull_requests'],
    unit: 'count_per_pr',
    aggregation: 'mean',
    direction: 'neutral',
    timeAnchor: 'pull_requests.merged_at',
    minimumSampleSize: 5,
    supportedScopes: NO_DEVELOPER,
    appliedFilters: COMMON_FILTERS,
    caveats: [
      'Neither direction is good or bad on its own: falling participation may mean a bus-factor problem or a deliberate move to single-reviewer policy.',
      'Authors reviewing their own pull requests are excluded.',
    ],
  },
  commit_frequency: {
    id: 'commit_frequency',
    name: 'Commit frequency',
    description: 'Commits landing per day.',
    formula: 'count(commits) / days in window',
    dataSource: ['commits'],
    unit: 'per_day',
    aggregation: 'per_day',
    direction: 'neutral',
    timeAnchor: 'commits.committed_at',
    minimumSampleSize: 1,
    supportedScopes: ALL_SCOPES,
    appliedFilters: [...COMMON_FILTERS, 'authorUserIds'],
    caveats: [
      'Commit counts reflect squash-versus-merge policy far more than effort. This metric exists to explain other metrics, not to evaluate anybody.',
    ],
  },
};

export const METRIC_IDS = Object.keys(METRIC_DEFINITIONS);

export function getMetricDefinition(id: string): MetricDefinition | null {
  return METRIC_DEFINITIONS[id] ?? null;
}

export function requireMetricDefinition(id: string): MetricDefinition {
  const def = METRIC_DEFINITIONS[id];
  if (!def) throw new Error(`Unknown metric "${id}". Known metrics: ${METRIC_IDS.join(', ')}`);
  return def;
}

/** Metrics whose window value can be rebuilt from daily snapshots alone. */
export function isAggregatable(def: MetricDefinition): boolean {
  return def.aggregation !== 'median';
}

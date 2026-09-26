/** Canonical, provider-neutral domain entities. */

export type Provider = 'github' | 'gitlab' | 'circleci' | 'jenkins';

export interface Organization {
  id: string;
  slug: string;
  name: string;
  /** Demo organizations carry synthetic data and must be labelled everywhere. */
  isDemo: boolean;
  createdAt: string;
}

export interface Team {
  id: string;
  orgId: string;
  slug: string;
  name: string;
}

export interface User {
  id: string;
  orgId: string;
  provider: Provider;
  providerUserId: string;
  login: string;
  name: string | null;
  isBot: boolean;
}

export interface Repository {
  id: string;
  orgId: string;
  provider: Provider;
  providerRepoId: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  teamId: string | null;
  archivedAt: string | null;
}

export interface Branch {
  id: string;
  repoId: string;
  name: string;
  isDefault: boolean;
}

export interface Commit {
  id: string;
  repoId: string;
  sha: string;
  authorUserId: string | null;
  authoredAt: string;
  committedAt: string;
  message: string;
  additions: number | null;
  deletions: number | null;
  pullRequestId: string | null;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export interface PullRequest {
  id: string;
  repoId: string;
  providerPrId: string;
  number: number;
  title: string;
  authorUserId: string | null;
  state: PullRequestState;
  isDraft: boolean;
  baseBranch: string;
  headBranch: string;
  createdAt: string;
  /** When the PR left draft, or createdAt if it was never a draft. Cycle time starts here. */
  readyForReviewAt: string | null;
  firstReviewAt: string | null;
  firstApprovalAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  reopenedCount: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  commitCount: number;
  mergeCommitSha: string | null;
}

export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed';

export interface Review {
  id: string;
  pullRequestId: string;
  reviewerUserId: string | null;
  state: ReviewState;
  submittedAt: string;
  /** When review was requested from this reviewer, if known. Turnaround starts here. */
  requestedAt: string | null;
}

export interface ReviewComment {
  id: string;
  pullRequestId: string;
  reviewId: string | null;
  authorUserId: string | null;
  createdAt: string;
  path: string | null;
  body: string;
}

export interface Workflow {
  id: string;
  repoId: string;
  provider: Provider;
  providerWorkflowId: string;
  name: string;
  path: string | null;
}

export type RunConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed_out'
  | 'skipped'
  | 'neutral'
  | 'action_required';

export type RunStatus = 'queued' | 'in_progress' | 'completed';

export interface WorkflowRun {
  id: string;
  repoId: string;
  workflowId: string;
  providerRunId: string;
  runAttempt: number;
  headSha: string;
  headBranch: string | null;
  pullRequestId: string | null;
  event: string;
  status: RunStatus;
  conclusion: RunConclusion | null;
  /** When the run was created / enqueued. */
  createdAt: string;
  /** When a runner actually picked it up. queue time = startedAt - createdAt. */
  startedAt: string | null;
  completedAt: string | null;
}

export type DeploymentState = 'pending' | 'in_progress' | 'success' | 'failure' | 'error' | 'inactive';

export interface Deployment {
  id: string;
  repoId: string;
  providerDeploymentId: string;
  environment: string;
  /** True for the environments that count toward DORA deployment frequency. */
  isProduction: boolean;
  sha: string;
  pullRequestId: string | null;
  state: DeploymentState;
  createdAt: string;
  completedAt: string | null;
}

export interface MetricSnapshot {
  id: string;
  orgId: string;
  metric: string;
  scopeType: ScopeType;
  scopeId: string;
  granularity: 'day' | 'week' | 'month';
  bucketStart: string;
  value: number | null;
  sampleSize: number;
  /** Sufficient statistics that let buckets be aggregated without re-reading raw rows. */
  numerator: number | null;
  denominator: number | null;
  computedAt: string;
}

export type ScopeType = 'org' | 'repository' | 'team' | 'branch' | 'developer';

export interface Anomaly {
  id: string;
  orgId: string;
  metric: string;
  scopeType: ScopeType;
  scopeId: string;
  detectedAt: string;
  windowStart: string;
  windowEnd: string;
  observedValue: number;
  baselineValue: number;
  /** Robust z-score (modified z using median/MAD), signed. */
  score: number;
  direction: 'increase' | 'decrease';
  severity: 'low' | 'medium' | 'high';
  confidence: 'low' | 'medium' | 'high';
  sampleSize: number;
  baselineSampleSize: number;
  status: 'open' | 'acknowledged' | 'resolved';
}

export interface Investigation {
  id: string;
  orgId: string;
  anomalyId: string | null;
  metric: string;
  scopeType: ScopeType;
  scopeId: string;
  windowStart: string;
  windowEnd: string;
  baselineStart: string;
  baselineEnd: string;
  createdAt: string;
  title: string;
}

export interface AuditLogEntry {
  id: string;
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  detail: Record<string, unknown>;
  createdAt: string;
}

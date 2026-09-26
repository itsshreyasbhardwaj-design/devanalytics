import { MS_PER_DAY } from '@devanalytics/core';
import {
  provisionOrganization,
  upsertCommit,
  upsertDeployment,
  upsertPullRequest,
  upsertRepository,
  upsertReview,
  upsertTeam,
  upsertUser,
  upsertWorkflow,
  upsertWorkflowRun,
  type Database,
} from '@devanalytics/db';

/**
 * Demo organization.
 *
 * Synthetic, seeded and reproducible. Every organization created here has
 * is_demo = true, and every surface that renders an organization checks that
 * flag and labels it — demo numbers are never presented as measurements of
 * anything real.
 *
 * The generator deliberately builds a *story* rather than noise: a review
 * bottleneck opens up in one repository in the final three weeks while
 * everything else stays flat, so anomaly detection and the investigation view
 * have a real signal to find and a real set of non-signals to reject.
 */

/** Deterministic PRNG. Same seed, same organization, forever. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Log-normal: engineering durations are right-skewed, never normal. */
function logNormal(rng: () => number, medianValue: number, sigma: number): number {
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return medianValue * Math.exp(sigma * z);
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

interface RepoSpec {
  name: string;
  team: string;
  /** Pull requests per weekday, on average. */
  prsPerDay: number;
  medianReviewWaitHours: number;
  medianMergeAfterApprovalHours: number;
  medianSizeLines: number;
  buildFailureRate: number;
  medianBuildMinutes: number;
  deploysPerWeek: number;
}

const REPOS: RepoSpec[] = [
  { name: 'northwind/checkout', team: 'payments', prsPerDay: 3.2, medianReviewWaitHours: 3, medianMergeAfterApprovalHours: 2, medianSizeLines: 180, buildFailureRate: 0.08, medianBuildMinutes: 11, deploysPerWeek: 9 },
  { name: 'northwind/catalog', team: 'discovery', prsPerDay: 2.4, medianReviewWaitHours: 5, medianMergeAfterApprovalHours: 3, medianSizeLines: 240, buildFailureRate: 0.06, medianBuildMinutes: 8, deploysPerWeek: 6 },
  { name: 'northwind/identity', team: 'platform', prsPerDay: 2.2, medianReviewWaitHours: 7, medianMergeAfterApprovalHours: 5, medianSizeLines: 120, buildFailureRate: 0.11, medianBuildMinutes: 17, deploysPerWeek: 3 },
  { name: 'northwind/infra', team: 'platform', prsPerDay: 1.9, medianReviewWaitHours: 9, medianMergeAfterApprovalHours: 8, medianSizeLines: 90, buildFailureRate: 0.14, medianBuildMinutes: 22, deploysPerWeek: 4 },
];

const TEAMS = [
  { slug: 'payments', name: 'Payments' },
  { slug: 'discovery', name: 'Discovery' },
  { slug: 'platform', name: 'Platform' },
];

const DEVS: Record<string, string[]> = {
  payments: ['ana', 'devon', 'kira', 'marcus', 'sofia'],
  discovery: ['priya', 'tom', 'wei', 'nadia'],
  platform: ['ines', 'jonas', 'omar', 'ruth', 'sam'],
};

export interface DemoScenario {
  /** Repository whose review capacity degrades. */
  repository: string;
  /** Days before `endDate` at which the regression starts. */
  startsDaysBeforeEnd: number;
  /** Multiplier applied to review wait time during the regression. */
  reviewWaitMultiplier: number;
  /** Multiplier applied to PR size during the regression. */
  sizeMultiplier: number;
  description: string;
}

export const DEFAULT_SCENARIO: DemoScenario = {
  repository: 'northwind/checkout',
  startsDaysBeforeEnd: 21,
  reviewWaitMultiplier: 4.2,
  sizeMultiplier: 1.6,
  description:
    'Three weeks before the end of the window, northwind/checkout loses review capacity: time to first review roughly quadruples and pull requests get larger. Cycle time follows. Nothing else in the organization changes, so a correct investigation should attribute most of the organization-level movement to this one repository and identify review latency and PR size as the associated metrics.',
};

export interface GenerateOptions {
  slug?: string;
  name?: string;
  days?: number;
  endDate?: Date;
  seed?: number;
  scenario?: DemoScenario | null;
}

export interface GenerateResult {
  orgId: string;
  slug: string;
  repositories: { id: string; fullName: string }[];
  counts: { pullRequests: number; reviews: number; commits: number; workflowRuns: number; deployments: number };
  windowStart: string;
  windowEnd: string;
  scenario: DemoScenario | null;
}

export async function generateDemoOrganization(db: Database, opts: GenerateOptions = {}): Promise<GenerateResult> {
  const slug = opts.slug ?? 'northwind-robotics';
  const days = opts.days ?? 120;
  const endDate = opts.endDate ?? new Date(Date.UTC(2026, 8, 1));
  const rng = mulberry32(opts.seed ?? 20260301);
  const scenario = opts.scenario === null ? null : (opts.scenario ?? DEFAULT_SCENARIO);

  const org = await provisionOrganization(db, { slug, name: opts.name ?? 'Northwind Robotics (demo)', isDemo: true });
  const start = new Date(endDate.getTime() - days * MS_PER_DAY);
  const regressionStart = scenario ? new Date(endDate.getTime() - scenario.startsDaysBeforeEnd * MS_PER_DAY) : null;

  const counts = { pullRequests: 0, reviews: 0, commits: 0, workflowRuns: 0, deployments: 0 };
  const repositories: { id: string; fullName: string }[] = [];

  await db.withOrg(org.id, async (sql) => {
    const teamIds: Record<string, string> = {};
    for (const t of TEAMS) teamIds[t.slug] = (await upsertTeam(sql, t)).id;

    const userIds: Record<string, string> = {};
    let userSeq = 1000;
    for (const [team, logins] of Object.entries(DEVS)) {
      for (const login of logins) {
        userIds[login] = (await upsertUser(sql, { provider: 'github', providerUserId: String(userSeq++), login, name: login })).id;
      }
      void team;
    }
    userIds['renovate[bot]'] = (
      await upsertUser(sql, { provider: 'github', providerUserId: '9001', login: 'renovate[bot]', isBot: true })
    ).id;

    let prNumber = 1;
    let runSeq = 1;
    let deploySeq = 1;

    for (const [repoIndex, spec] of REPOS.entries()) {
      const repo = await upsertRepository(sql, {
        provider: 'github',
        providerRepoId: String(repoIndex + 1),
        name: spec.name.split('/')[1] as string,
        fullName: spec.name,
        defaultBranch: 'main',
        isPrivate: true,
        teamId: teamIds[spec.team] as string,
      });
      repositories.push({ id: repo.id, fullName: spec.name });

      const workflowId = await upsertWorkflow(sql, {
        repoId: repo.id, provider: 'github', providerWorkflowId: `wf-${repoIndex}`, name: 'CI', path: '.github/workflows/ci.yml',
      });
      const team = DEVS[spec.team] as string[];

      for (let day = 0; day < days; day++) {
        const dayStart = new Date(start.getTime() + day * MS_PER_DAY);
        const dow = dayStart.getUTCDay();
        // Weekends are real and visible in engineering data; flattening them
        // would make every Monday look like an anomaly.
        const activity = dow === 0 || dow === 6 ? 0.15 : 1;
        const inRegression =
          regressionStart !== null && scenario !== null && spec.name === scenario.repository && dayStart >= regressionStart;
        const reviewMultiplier = inRegression ? scenario.reviewWaitMultiplier : 1;
        const sizeMultiplier = inRegression ? scenario.sizeMultiplier : 1;

        const prCount = Math.round(spec.prsPerDay * activity * (0.6 + rng() * 0.8));
        for (let i = 0; i < prCount; i++) {
          const author = pick(rng, team);
          const isBot = rng() < 0.07;
          const authorId = isBot ? (userIds['renovate[bot]'] as string) : (userIds[author] as string);
          const readyAt = new Date(dayStart.getTime() + Math.floor(rng() * 10 + 8) * 3_600_000);
          const size = Math.max(5, Math.round(logNormal(rng, spec.medianSizeLines * sizeMultiplier, 0.8)));

          const reviewWaitH = logNormal(rng, spec.medianReviewWaitHours * reviewMultiplier, 0.6);
          const approvalExtraH = logNormal(rng, 1.2, 0.6);
          const mergeAfterApprovalH = logNormal(rng, spec.medianMergeAfterApprovalHours, 0.7);

          const firstReviewAt = new Date(readyAt.getTime() + reviewWaitH * 3_600_000);
          const approvalAt = new Date(firstReviewAt.getTime() + approvalExtraH * 3_600_000);
          const mergedAt = new Date(approvalAt.getTime() + mergeAfterApprovalH * 3_600_000);
          // 12% of PRs are still open or were abandoned.
          const outcome = rng();
          const merged = outcome > 0.12 && mergedAt < endDate;
          const closedUnmerged = !merged && outcome > 0.06 && mergedAt < endDate;

          const number = prNumber++;
          const prId = await upsertPullRequest(sql, {
            repoId: repo.id,
            providerPrId: `demo-${number}`,
            number,
            title: pick(rng, [
              'Fix retry backoff on payment capture', 'Add idempotency key to checkout', 'Upgrade search index mapping',
              'Cache catalog facets', 'Rotate signing keys', 'Split identity migration', 'Reduce cold start in worker',
              'Tighten webhook validation', 'Add tracing to order pipeline', 'Remove dead feature flag',
            ]),
            authorUserId: authorId,
            state: merged ? 'merged' : closedUnmerged ? 'closed' : 'open',
            isDraft: false,
            baseBranch: 'main',
            headBranch: `${isBot ? 'renovate' : author}/${number}`,
            createdAt: readyAt.toISOString(),
            readyForReviewAt: readyAt.toISOString(),
            mergedAt: merged ? mergedAt.toISOString() : null,
            closedAt: merged ? mergedAt.toISOString() : closedUnmerged ? mergedAt.toISOString() : null,
            additions: Math.ceil(size * 0.7),
            deletions: Math.floor(size * 0.3),
            changedFiles: Math.max(1, Math.round(size / 60)),
            commitCount: Math.max(1, Math.round(rng() * 5)),
            mergeCommitSha: merged ? `m${number}` : null,
            reopened: rng() < 0.03,
          });
          counts.pullRequests++;

          if (!isBot && firstReviewAt < endDate) {
            const reviewers = team.filter((r) => r !== author);
            const reviewerCount = rng() < 0.25 ? 2 : 1;
            for (let r = 0; r < reviewerCount; r++) {
              const reviewer = pick(rng, reviewers);
              const submittedAt = r === 0 ? firstReviewAt : new Date(firstReviewAt.getTime() + rng() * 4 * 3_600_000);
              await upsertReview(sql, {
                repoId: repo.id,
                pullRequestId: prId,
                providerReviewId: `rev-${number}-${r}`,
                reviewerUserId: userIds[reviewer] as string,
                state: r === 0 ? 'commented' : 'approved',
                submittedAt: submittedAt.toISOString(),
                requestedAt: readyAt.toISOString(),
              });
              counts.reviews++;
            }
            if (merged) {
              await upsertReview(sql, {
                repoId: repo.id,
                pullRequestId: prId,
                providerReviewId: `rev-${number}-approve`,
                reviewerUserId: userIds[pick(rng, reviewers)] as string,
                state: 'approved',
                submittedAt: approvalAt.toISOString(),
                requestedAt: readyAt.toISOString(),
              });
              counts.reviews++;
            }
          }

          const commitCount = Math.max(1, Math.round(rng() * 4));
          for (let c = 0; c < commitCount; c++) {
            const at = new Date(readyAt.getTime() - (commitCount - c) * 3_600_000 * (1 + rng() * 6));
            await upsertCommit(sql, {
              repoId: repo.id, sha: `c${number}-${c}`, authorUserId: authorId,
              authoredAt: at.toISOString(), committedAt: at.toISOString(),
              pullRequestId: prId, branch: `${author}/${number}`, message: 'work',
              additions: Math.round(size / commitCount), deletions: 0,
            });
            counts.commits++;
          }

          // CI: queue time rises across the whole organization in the final week.
          const lastWeek = dayStart.getTime() >= endDate.getTime() - 7 * MS_PER_DAY;
          const runCount = 1 + Math.round(rng() * 2);
          for (let r = 0; r < runCount; r++) {
            const createdAt = new Date(readyAt.getTime() + r * 1_800_000);
            const queueMin = logNormal(rng, lastWeek ? 6 : 1.4, 0.6);
            const startedAt = new Date(createdAt.getTime() + queueMin * 60_000);
            const durationMin = logNormal(rng, spec.medianBuildMinutes, 0.45);
            const completedAt = new Date(startedAt.getTime() + durationMin * 60_000);
            if (completedAt >= endDate) continue;
            await upsertWorkflowRun(sql, {
              repoId: repo.id, workflowId, providerRunId: `run-${runSeq++}`,
              headSha: `c${number}-0`, headBranch: 'main', pullRequestId: prId, event: 'pull_request',
              status: 'completed',
              conclusion: rng() < spec.buildFailureRate ? 'failure' : 'success',
              createdAt: createdAt.toISOString(), startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
            });
            counts.workflowRuns++;
          }

          if (merged && rng() < spec.deploysPerWeek / (spec.prsPerDay * 7)) {
            const deployAt = new Date(mergedAt.getTime() + logNormal(rng, 2, 0.8) * 3_600_000);
            if (deployAt < endDate) {
              await upsertDeployment(sql, {
                repoId: repo.id, providerDeploymentId: `dep-${deploySeq++}`, environment: 'production',
                isProduction: true, sha: `m${number}`, pullRequestId: prId,
                state: rng() < 0.05 ? 'failure' : 'success',
                createdAt: deployAt.toISOString(), completedAt: deployAt.toISOString(),
              });
              counts.deployments++;
            }
          }
        }
      }
    }
  });

  return {
    orgId: org.id,
    slug,
    repositories,
    counts,
    windowStart: start.toISOString(),
    windowEnd: endDate.toISOString(),
    scenario,
  };
}

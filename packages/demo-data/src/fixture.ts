import type { TimeWindow } from '@devanalytics/core';
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
 * The metric test dataset.
 *
 * Small enough that every expected value below was computed by hand from the
 * table, not from the engine. The unit and integration suites assert the
 * engine reproduces these numbers exactly; if a metric definition changes, the
 * expectation has to be re-derived by a human, which is the point.
 *
 * Documented in full in docs/METRIC-TEST-DATASET.md.
 */

export const FIXTURE_ORG_SLUG = 'fixture-co';
export const FIXTURE_REPO = 'fixture-co/app';

export const FIXTURE_WINDOW: TimeWindow = {
  from: '2026-03-01T00:00:00.000Z',
  to: '2026-03-08T00:00:00.000Z',
};

const T = (day: number, hour = 0, minute = 0): string =>
  new Date(Date.UTC(2026, 2, day, hour, minute)).toISOString();

interface FixturePr {
  number: number;
  author: string;
  ready: string;
  merged?: string;
  closed?: string;
  reopened?: boolean;
  size: number;
  /** [reviewer, state, requestedAt, submittedAt] */
  reviews: [string, 'approved' | 'commented', string, string][];
  /** Hours from the PR's earliest commit to its production deployment. */
  leadHours?: number;
}

const PRS: FixturePr[] = [
  {
    number: 1, author: 'alice', ready: T(1, 0), merged: T(1, 4), size: 100, leadHours: 10,
    reviews: [['bob', 'commented', T(1, 0), T(1, 1)], ['bob', 'approved', T(1, 0), T(1, 3)]],
  },
  {
    number: 2, author: 'bob', ready: T(2, 0), merged: T(2, 10), size: 200, leadHours: 20,
    reviews: [['carol', 'approved', T(2, 0), T(2, 6)]],
  },
  {
    number: 3, author: 'carol', ready: T(3, 0), merged: T(3, 8), size: 300, leadHours: 30,
    reviews: [['alice', 'commented', T(3, 0), T(3, 1)], ['bob', 'approved', T(3, 0), T(3, 2)]],
  },
  {
    number: 4, author: 'alice', ready: T(4, 0), merged: T(4, 20), size: 50, leadHours: 40,
    reviews: [['carol', 'approved', T(4, 0), T(4, 12)]],
  },
  {
    number: 5, author: 'bob', ready: T(5, 0), merged: T(5, 6), size: 400, leadHours: 50,
    reviews: [['alice', 'approved', T(5, 0), T(5, 3)]],
  },
  // Bot-authored: excluded from every metric by the default excludeBots filter.
  { number: 6, author: 'dependabot', ready: T(6, 0), merged: T(6, 1), size: 999, reviews: [] },
  // Open, reviewed: contributes to time-to-first-review but not to cycle time.
  { number: 7, author: 'carol', ready: T(6, 0), size: 150, reviews: [['bob', 'commented', T(6, 0), T(6, 5)]] },
  // Closed unmerged after a reopen: the only reopened PR in the window.
  { number: 8, author: 'alice', ready: T(7, 0), closed: T(7, 6), reopened: true, size: 250, reviews: [] },
];

export interface FixtureIds {
  orgId: string;
  repoId: string;
  teamId: string;
  userIds: Record<string, string>;
  prIds: Record<number, string>;
}

export async function loadFixture(db: Database): Promise<FixtureIds> {
  const org = await provisionOrganization(db, { slug: FIXTURE_ORG_SLUG, name: 'Fixture Co', isDemo: true });

  return db.withOrg(org.id, async (sql) => {
    const team = await upsertTeam(sql, { slug: 'platform', name: 'Platform' });
    const repo = await upsertRepository(sql, {
      provider: 'github', providerRepoId: '1', name: 'app', fullName: FIXTURE_REPO,
      defaultBranch: 'main', isPrivate: true, teamId: team.id,
    });

    const userIds: Record<string, string> = {};
    for (const [i, login] of ['alice', 'bob', 'carol'].entries()) {
      userIds[login] = (await upsertUser(sql, { provider: 'github', providerUserId: String(100 + i), login })).id;
    }
    userIds.dependabot = (
      await upsertUser(sql, { provider: 'github', providerUserId: '200', login: 'dependabot[bot]', isBot: true })
    ).id;

    const prIds: Record<number, string> = {};
    for (const pr of PRS) {
      const authorId = userIds[pr.author];
      const prId = await upsertPullRequest(sql, {
        repoId: repo.id,
        providerPrId: `pr-${pr.number}`,
        number: pr.number,
        title: `Fixture PR ${pr.number}`,
        authorUserId: authorId ?? null,
        state: pr.merged ? 'merged' : pr.closed ? 'closed' : 'open',
        isDraft: false,
        baseBranch: 'main',
        headBranch: `feature/${pr.number}`,
        createdAt: pr.ready,
        readyForReviewAt: pr.ready,
        mergedAt: pr.merged ?? null,
        closedAt: pr.closed ?? pr.merged ?? null,
        // Sizes are split so additions + deletions equals the documented size.
        additions: Math.ceil(pr.size / 2),
        deletions: Math.floor(pr.size / 2),
        changedFiles: Math.max(1, Math.round(pr.size / 50)),
        commitCount: 2,
        reopened: pr.reopened ?? false,
      });
      prIds[pr.number] = prId;

      for (const [idx, [reviewer, state, requestedAt, submittedAt]] of pr.reviews.entries()) {
        await upsertReview(sql, {
          repoId: repo.id,
          pullRequestId: prId,
          providerReviewId: `rev-${pr.number}-${idx}`,
          reviewerUserId: userIds[reviewer] ?? null,
          state,
          submittedAt,
          requestedAt,
        });
      }

      // Two commits per PR. The first is authored early enough to produce the
      // documented lead time; both are committed inside the window.
      const deployAt = pr.merged ? new Date(new Date(pr.merged).getTime() + 3_600_000).toISOString() : null;
      const firstAuthored =
        pr.leadHours && deployAt
          ? new Date(new Date(deployAt).getTime() - pr.leadHours * 3_600_000).toISOString()
          : pr.ready;
      await upsertCommit(sql, {
        repoId: repo.id, sha: `sha-${pr.number}-a`, authorUserId: authorId ?? null,
        authoredAt: firstAuthored, committedAt: pr.ready, pullRequestId: prId,
        branch: `feature/${pr.number}`, message: 'first',
      });
      await upsertCommit(sql, {
        repoId: repo.id, sha: `sha-${pr.number}-b`, authorUserId: authorId ?? null,
        authoredAt: new Date(new Date(pr.ready).getTime() + 3_600_000).toISOString(),
        committedAt: new Date(new Date(pr.ready).getTime() + 3_600_000).toISOString(),
        pullRequestId: prId, branch: `feature/${pr.number}`, message: 'second',
      });
    }

    // --- CI: 30 conclusive runs (24 success, 6 failure) plus 2 cancelled ---
    const workflowId = await upsertWorkflow(sql, {
      repoId: repo.id, provider: 'github', providerWorkflowId: 'ci', name: 'CI', path: '.github/workflows/ci.yml',
    });
    for (let i = 0; i < 30; i++) {
      const day = 1 + (i % 5);
      const created = new Date(Date.UTC(2026, 2, day, 8, i));
      const queueMinutes = i < 15 ? 1 : 3;
      const durationMinutes = i < 15 ? 4 : 8;
      const started = new Date(created.getTime() + queueMinutes * 60_000);
      const completed = new Date(started.getTime() + durationMinutes * 60_000);
      await upsertWorkflowRun(sql, {
        repoId: repo.id, workflowId, providerRunId: `run-${i}`, headSha: `sha-${i}`, headBranch: 'main',
        event: 'push', status: 'completed',
        conclusion: i < 24 ? 'success' : 'failure',
        createdAt: created.toISOString(), enqueuedAt: created.toISOString(),
        startedAt: started.toISOString(), completedAt: completed.toISOString(),
      });
    }
    for (let i = 0; i < 2; i++) {
      const created = new Date(Date.UTC(2026, 2, 2, 9, i));
      await upsertWorkflowRun(sql, {
        repoId: repo.id, workflowId, providerRunId: `cancelled-${i}`, headSha: `csha-${i}`, headBranch: 'main',
        event: 'push', status: 'completed', conclusion: 'cancelled',
        createdAt: created.toISOString(), enqueuedAt: created.toISOString(), startedAt: null,
        completedAt: new Date(created.getTime() + 60_000).toISOString(),
      });
    }

    // --- Deployments: 12 production (10 success, 2 failure) ---
    for (const pr of PRS) {
      if (!pr.merged || !pr.leadHours) continue;
      const createdAt = new Date(new Date(pr.merged).getTime() + 3_600_000).toISOString();
      await upsertDeployment(sql, {
        repoId: repo.id, providerDeploymentId: `dep-pr-${pr.number}`, environment: 'production',
        isProduction: true, sha: `sha-${pr.number}-b`, pullRequestId: prIds[pr.number] ?? null,
        state: 'success', createdAt, completedAt: createdAt,
      });
    }
    for (let i = 0; i < 5; i++) {
      const createdAt = new Date(Date.UTC(2026, 2, 2 + i, 18)).toISOString();
      await upsertDeployment(sql, {
        repoId: repo.id, providerDeploymentId: `dep-solo-${i}`, environment: 'production',
        isProduction: true, sha: `solo-${i}`, state: 'success', createdAt, completedAt: createdAt,
      });
    }
    for (let i = 0; i < 2; i++) {
      const createdAt = new Date(Date.UTC(2026, 2, 4 + i, 21)).toISOString();
      await upsertDeployment(sql, {
        repoId: repo.id, providerDeploymentId: `dep-fail-${i}`, environment: 'production',
        isProduction: true, sha: `fail-${i}`, state: 'failure', createdAt, completedAt: createdAt,
      });
    }
    // Staging deployments must not leak into DORA metrics.
    for (let i = 0; i < 20; i++) {
      const createdAt = new Date(Date.UTC(2026, 2, 1 + (i % 7), 12, i)).toISOString();
      await upsertDeployment(sql, {
        repoId: repo.id, providerDeploymentId: `dep-staging-${i}`, environment: 'staging',
        isProduction: false, sha: `stg-${i}`, state: i % 4 === 0 ? 'failure' : 'success', createdAt, completedAt: createdAt,
      });
    }

    return { orgId: org.id, repoId: repo.id, teamId: team.id, userIds, prIds };
  });
}

/**
 * Hand-derived expected values over FIXTURE_WINDOW at org scope with default
 * filters (excludeBots: true, productionOnly: true).
 *
 * Derivations live in docs/METRIC-TEST-DATASET.md.
 */
export const FIXTURE_EXPECTATIONS: Record<
  string,
  { value: number | null; sampleSize: number; status: 'ok' | 'insufficient_data'; derivation: string }
> = {
  pr_cycle_time: {
    value: 8, sampleSize: 5, status: 'ok',
    derivation: 'merged non-bot PRs 1-5 -> [4,10,8,20,6] h; median = 8',
  },
  pr_cycle_time_mean: {
    value: 9.6, sampleSize: 5, status: 'ok',
    derivation: '(4+10+8+20+6)/5 = 48/5 = 9.6 h',
  },
  time_to_first_review: {
    value: 4, sampleSize: 6, status: 'ok',
    derivation: 'PRs 1-5 and 7 -> [1,6,1,12,3,5] h; sorted [1,1,3,5,6,12]; median = (3+5)/2 = 4',
  },
  merge_time: {
    value: 4, sampleSize: 5, status: 'ok',
    derivation: 'merged_at - first_approval_at -> [1,4,6,8,3] h; sorted [1,3,4,6,8]; median = 4',
  },
  review_turnaround_time: {
    value: 3, sampleSize: 8, status: 'ok',
    derivation: 'all 8 non-self reviews -> [1,3,6,1,2,12,3,5]; sorted [1,1,2,3,3,5,6,12]; median = (3+3)/2 = 3',
  },
  pr_size: {
    value: 200, sampleSize: 7, status: 'ok',
    derivation: 'non-bot PRs created in window -> [100,200,300,50,400,150,250]; median = 200 lines',
  },
  review_participation: {
    value: 1.2, sampleSize: 5, status: 'ok',
    derivation: 'distinct non-author reviewers per merged PR -> [1,1,2,1,1]; mean = 6/5 = 1.2',
  },
  reopened_pr_rate: {
    value: null, sampleSize: 6, status: 'insufficient_data',
    derivation: '6 closed/merged non-bot PRs < minimum sample of 20 -> Insufficient data (the true ratio would be 1/6)',
  },
  build_success_rate: {
    value: 0.8, sampleSize: 30, status: 'ok',
    derivation: '24 success / (24 success + 6 failure) = 0.8; 2 cancelled runs excluded from both sides',
  },
  build_duration: {
    value: 6, sampleSize: 30, status: 'ok',
    derivation: '15 runs of 4 min and 15 of 8 min; median = (4+8)/2 = 6 min',
  },
  ci_queue_time: {
    value: 2, sampleSize: 30, status: 'ok',
    derivation: '15 runs queued 1 min and 15 queued 3 min; median = (1+3)/2 = 2 min',
  },
  deployment_frequency: {
    value: 10 / 7, sampleSize: 10, status: 'ok',
    derivation: '10 successful production deployments over a 7-day window = 1.4286/day; 20 staging deployments excluded',
  },
  failed_deployment_rate: {
    value: 2 / 12, sampleSize: 12, status: 'ok',
    derivation: '2 failed / 12 production deployments = 0.1667',
  },
  lead_time_for_changes: {
    value: 30, sampleSize: 5, status: 'ok',
    derivation: 'PR-linked production deployments -> [10,20,30,40,50] h; median = 30; 5 unlinked deployments excluded',
  },
  commit_frequency: {
    value: 2, sampleSize: 14, status: 'ok',
    derivation: '7 non-bot PRs x 2 commits = 14 commits over a 7-day window = 2.0/day; the bot PR\'s commits are excluded',
  },
};

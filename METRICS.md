# Metric definitions

<!-- GENERATED FILE. Run `pnpm docs:metrics` after changing packages/metrics/src/definitions.ts. -->

Every metric DevAnalytics computes, with its exact formula, source tables, time anchor and minimum sample size.
This file is generated from `packages/metrics/src/definitions.ts`, which is the same registry the engine, the API,
the SDK, the MCP server and the AI layer read. A metric that is not here cannot be computed, charted or cited anywhere.

## Reading these definitions

**Time anchor** is the column that places a record in a time bucket. It is stated explicitly because it is the most
common source of disagreement between two tools reporting "the same" metric: a pull request opened in March and merged
in April belongs to March for PR size and to April for cycle time.

**Minimum sample size** is the number of observations required before a value is reported at all. Below it, the metric
returns `insufficient_data` with the counts, and every surface renders the words "Insufficient data". No surface
substitutes zero.

**Aggregation** determines whether a window value can be rebuilt from daily snapshots. Medians cannot: the median of
daily medians is not the median. Those metrics are recomputed from records and are marked below.

**Windows** are half-open, `[from, to)`. That is what makes daily, weekly and monthly buckets tile the timeline exactly
once, with no record counted twice and none dropped.

## Summary

| Metric | Unit | Direction | Aggregation | Min. sample | Time anchor |
| --- | --- | --- | --- | ---: | --- |
| [PR cycle time](#pr-cycle-time) | hours | lower is better | median (not aggregatable) | 5 | `pull_requests.merged_at` |
| [PR cycle time (mean)](#pr-cycle-time-mean) | hours | lower is better | mean | 5 | `pull_requests.merged_at` |
| [Time to first review](#time-to-first-review) | hours | lower is better | median (not aggregatable) | 5 | `pull_requests.first_review_at` |
| [Review turnaround time](#review-turnaround-time) | hours | lower is better | median (not aggregatable) | 5 | `reviews.submitted_at` |
| [Merge time](#merge-time) | hours | lower is better | median (not aggregatable) | 5 | `pull_requests.merged_at` |
| [PR size](#pr-size) | lines | lower is better | median (not aggregatable) | 5 | `pull_requests.created_at` |
| [Deployment frequency](#deployment-frequency) | per_day | higher is better | per_day | 1 | `deployments.created_at` |
| [Lead time for changes](#lead-time-for-changes) | hours | lower is better | median (not aggregatable) | 3 | `deployments.created_at` |
| [Build success rate](#build-success-rate) | ratio | higher is better | rate | 20 | `workflow_runs.completed_at` |
| [Build duration](#build-duration) | minutes | lower is better | median (not aggregatable) | 20 | `workflow_runs.completed_at` |
| [CI queue time](#ci-queue-time) | minutes | lower is better | median (not aggregatable) | 20 | `workflow_runs.created_at` |
| [Failed deployment rate](#failed-deployment-rate) | ratio | lower is better | rate | 10 | `deployments.created_at` |
| [Reopened PR rate](#reopened-pr-rate) | ratio | lower is better | rate | 20 | `coalesce(pull_requests.merged_at, pull_requests.closed_at)` |
| [Review participation](#review-participation) | count_per_pr | neutral | mean | 5 | `pull_requests.merged_at` |
| [Commit frequency](#commit-frequency) | per_day | neutral | per_day | 1 | `commits.committed_at` |

## pr-cycle-time

### PR cycle time

How long a pull request takes from the moment it is ready for review until it is merged.

- **Id**: `pr_cycle_time`
- **Formula**: median(merged_at - ready_for_review_at) over pull requests merged in the window
- **Data source**: `pull_requests`
- **Unit**: hours
- **Time anchor**: `pull_requests.merged_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Only merged pull requests contribute. Closed-without-merge PRs are excluded because they have no end state to measure to.
- The clock starts at ready_for_review_at, not created_at, so time spent in draft is not counted against the reviewer.
- Time is wall-clock, including nights and weekends. No working-hours calendar is assumed.

**Verified against the metric test dataset**

Expected value `8` from 5 observations. Derivation: merged non-bot PRs 1-5 -> [4,10,8,20,6] h; median = 8

## pr-cycle-time-mean

### PR cycle time (mean)

Arithmetic mean of PR cycle time. Published alongside the median because it is aggregatable and therefore cheap over long windows.

- **Id**: `pr_cycle_time_mean`
- **Formula**: sum(merged_at - ready_for_review_at) / count(merged pull requests)
- **Data source**: `pull_requests`
- **Unit**: hours
- **Time anchor**: `pull_requests.merged_at`
- **Aggregation**: mean (window values can be rebuilt from daily snapshots)
- **Direction**: lower is better
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Sensitive to a single very old PR being merged. Prefer the median for reporting; use the mean for decomposition arithmetic.

**Verified against the metric test dataset**

Expected value `9.6` from 5 observations. Derivation: (4+10+8+20+6)/5 = 48/5 = 9.6 h

## time-to-first-review

### Time to first review

How long a pull request waits before any reviewer responds.

- **Id**: `time_to_first_review`
- **Formula**: median(first_review_at - ready_for_review_at) over pull requests that received a review in the window
- **Data source**: `pull_requests`, `reviews`
- **Unit**: hours
- **Time anchor**: `pull_requests.first_review_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Pull requests that never received a review are excluded, so a rising review backlog can *lower* this metric. Read it next to review participation.
- Self-reviews are excluded.

**Verified against the metric test dataset**

Expected value `4` from 6 observations. Derivation: PRs 1-5 and 7 -> [1,6,1,12,3,5] h; sorted [1,1,3,5,6,12]; median = (3+5)/2 = 4

## review-turnaround-time

### Review turnaround time

How long an individual reviewer takes to respond once review is requested.

- **Id**: `review_turnaround_time`
- **Formula**: median(review.submitted_at - coalesce(review.requested_at, pull_request.ready_for_review_at)) over reviews submitted in the window
- **Data source**: `reviews`, `pull_requests`
- **Unit**: hours
- **Time anchor**: `reviews.submitted_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots

**Caveats**

- Measured per review, not per pull request: a PR with three reviewers contributes three observations.
- When the host does not report a review request timestamp, the PR ready time is used instead, which overstates turnaround for reviewers added late.

**Verified against the metric test dataset**

Expected value `3` from 8 observations. Derivation: all 8 non-self reviews -> [1,3,6,1,2,12,3,5]; sorted [1,1,2,3,3,5,6,12]; median = (3+3)/2 = 3

## merge-time

### Merge time

How long an approved pull request waits before it is actually merged.

- **Id**: `merge_time`
- **Formula**: median(merged_at - first_approval_at) over pull requests merged in the window that had an approval
- **Data source**: `pull_requests`
- **Unit**: hours
- **Time anchor**: `pull_requests.merged_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Pull requests merged without an approval are excluded. In repositories that do not require review this metric covers very few PRs — check the sample size.
- Often dominated by required status checks rather than human delay; compare against build duration.

**Verified against the metric test dataset**

Expected value `4` from 5 observations. Derivation: merged_at - first_approval_at -> [1,4,6,8,3] h; sorted [1,3,4,6,8]; median = 4

## pr-size

### PR size

Lines changed per pull request. The single strongest correlate of slow review in most repositories.

- **Id**: `pr_size`
- **Formula**: median(additions + deletions) over pull requests opened in the window
- **Data source**: `pull_requests`
- **Unit**: lines
- **Time anchor**: `pull_requests.created_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Counts every changed line, including generated files and lockfiles, unless the host reported them separately.
- Anchored on creation, not merge, so it describes what the team is *sending* for review in the window.

**Verified against the metric test dataset**

Expected value `200` from 7 observations. Derivation: non-bot PRs created in window -> [100,200,300,50,400,150,250]; median = 200 lines

## deployment-frequency

### Deployment frequency

Successful production deployments per day. One of the four DORA metrics.

- **Id**: `deployment_frequency`
- **Formula**: count(successful production deployments) / days in window
- **Data source**: `deployments`
- **Unit**: per_day
- **Time anchor**: `deployments.created_at`
- **Aggregation**: per_day (window values can be rebuilt from daily snapshots)
- **Direction**: higher is better
- **Minimum sample size**: 1 observations
- **Supported scopes**: org, repository, team
- **Applicable filters**: repositoryIds, teamIds, productionOnly

**Caveats**

- Only environments marked production count. Staging and preview deployments are ingested but excluded here.
- A deployment that failed and was retried counts once, on success.

**Verified against the metric test dataset**

Expected value `1.4285714285714286` from 10 observations. Derivation: 10 successful production deployments over a 7-day window = 1.4286/day; 20 staging deployments excluded

## lead-time-for-changes

### Lead time for changes

How long a commit takes to reach production. One of the four DORA metrics.

- **Id**: `lead_time_for_changes`
- **Formula**: median(deployment.created_at - first commit authored_at on the pull request) over production deployments in the window
- **Data source**: `deployments`, `pull_requests`, `commits`
- **Unit**: hours
- **Time anchor**: `deployments.created_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 3 observations
- **Supported scopes**: org, repository, team
- **Applicable filters**: repositoryIds, teamIds, productionOnly

**Caveats**

- Requires deployments to be linked to a pull request. Deployments with no linked PR are excluded, and the exclusion count is reported alongside the value.
- Uses the earliest commit on the pull request, so long-lived branches inflate this metric by design — that is the signal, not an error.

**Verified against the metric test dataset**

Expected value `30` from 5 observations. Derivation: PR-linked production deployments -> [10,20,30,40,50] h; median = 30; 5 unlinked deployments excluded

## build-success-rate

### Build success rate

Share of completed CI runs that succeeded.

- **Id**: `build_success_rate`
- **Formula**: count(runs with conclusion = success) / count(runs with conclusion in (success, failure, timed_out))
- **Data source**: `workflow_runs`
- **Unit**: ratio
- **Time anchor**: `workflow_runs.completed_at`
- **Aggregation**: rate (window values can be rebuilt from daily snapshots)
- **Direction**: higher is better
- **Minimum sample size**: 20 observations
- **Supported scopes**: org, repository, team, branch
- **Applicable filters**: repositoryIds, teamIds, branches

**Caveats**

- Cancelled and skipped runs are excluded from both numerator and denominator: they carry no signal about whether the build works.
- Each retry is a separate run, so a flaky job that passes on attempt 3 lowers this rate. That is intentional.

**Verified against the metric test dataset**

Expected value `0.8` from 30 observations. Derivation: 24 success / (24 success + 6 failure) = 0.8; 2 cancelled runs excluded from both sides

## build-duration

### Build duration

How long CI takes once a runner picks the job up.

- **Id**: `build_duration`
- **Formula**: median(completed_at - started_at) over completed CI runs in the window
- **Data source**: `workflow_runs`
- **Unit**: minutes
- **Time anchor**: `workflow_runs.completed_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 20 observations
- **Supported scopes**: org, repository, team, branch
- **Applicable filters**: repositoryIds, teamIds, branches

**Caveats**

- Excludes queue time, which is reported separately as CI queue time. A slow pipeline and a starved runner pool look identical if the two are added together.

**Verified against the metric test dataset**

Expected value `6` from 30 observations. Derivation: 15 runs of 4 min and 15 of 8 min; median = (4+8)/2 = 6 min

## ci-queue-time

### CI queue time

How long CI runs wait for a runner before starting.

- **Id**: `ci_queue_time`
- **Formula**: median(started_at - created_at) over CI runs started in the window
- **Data source**: `workflow_runs`
- **Unit**: minutes
- **Time anchor**: `workflow_runs.created_at`
- **Aggregation**: median (recomputed from records; a median of medians would be wrong)
- **Direction**: lower is better
- **Minimum sample size**: 20 observations
- **Supported scopes**: org, repository, team, branch
- **Applicable filters**: repositoryIds, teamIds, branches

**Caveats**

- Rising queue time with flat build duration points at runner capacity, not at the pipeline.

**Verified against the metric test dataset**

Expected value `2` from 30 observations. Derivation: 15 runs queued 1 min and 15 queued 3 min; median = (1+3)/2 = 2 min

## failed-deployment-rate

### Failed deployment rate

Share of production deployments that ended in failure. Related to, but not identical to, the DORA change failure rate.

- **Id**: `failed_deployment_rate`
- **Formula**: count(production deployments in state failure or error) / count(production deployments)
- **Data source**: `deployments`
- **Unit**: ratio
- **Time anchor**: `deployments.created_at`
- **Aggregation**: rate (window values can be rebuilt from daily snapshots)
- **Direction**: lower is better
- **Minimum sample size**: 10 observations
- **Supported scopes**: org, repository, team
- **Applicable filters**: repositoryIds, teamIds, productionOnly

**Caveats**

- Measures deployment mechanics failing, not incidents caused by a successful deployment. It is a lower bound on change failure rate, never a substitute.

**Verified against the metric test dataset**

Expected value `0.16666666666666666` from 12 observations. Derivation: 2 failed / 12 production deployments = 0.1667

## reopened-pr-rate

### Reopened PR rate

Share of closed pull requests that had to be reopened at least once.

- **Id**: `reopened_pr_rate`
- **Formula**: count(pull requests with reopened_count > 0) / count(pull requests closed or merged in the window)
- **Data source**: `pull_requests`
- **Unit**: ratio
- **Time anchor**: `coalesce(pull_requests.merged_at, pull_requests.closed_at)`
- **Aggregation**: rate (window values can be rebuilt from daily snapshots)
- **Direction**: lower is better
- **Minimum sample size**: 20 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Reopening is a weak proxy for rework and is used very differently between teams. Compare a repository against its own history, not against another repository.

**Verified against the metric test dataset**

Expected `insufficient_data` with 6 observations. Derivation: 6 closed/merged non-bot PRs < minimum sample of 20 -> Insufficient data (the true ratio would be 1/6)

## review-participation

### Review participation

Distinct reviewers per merged pull request.

- **Id**: `review_participation`
- **Formula**: count(distinct reviewers) / count(merged pull requests) over the window
- **Data source**: `reviews`, `pull_requests`
- **Unit**: count_per_pr
- **Time anchor**: `pull_requests.merged_at`
- **Aggregation**: mean (window values can be rebuilt from daily snapshots)
- **Direction**: neutral
- **Minimum sample size**: 5 observations
- **Supported scopes**: org, repository, team, branch
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots

**Caveats**

- Neither direction is good or bad on its own: falling participation may mean a bus-factor problem or a deliberate move to single-reviewer policy.
- Authors reviewing their own pull requests are excluded.

**Verified against the metric test dataset**

Expected value `1.2` from 5 observations. Derivation: distinct non-author reviewers per merged PR -> [1,1,2,1,1]; mean = 6/5 = 1.2

## commit-frequency

### Commit frequency

Commits landing per day.

- **Id**: `commit_frequency`
- **Formula**: count(commits) / days in window
- **Data source**: `commits`
- **Unit**: per_day
- **Time anchor**: `commits.committed_at`
- **Aggregation**: per_day (window values can be rebuilt from daily snapshots)
- **Direction**: neutral
- **Minimum sample size**: 1 observations
- **Supported scopes**: org, repository, team, branch, developer
- **Applicable filters**: repositoryIds, teamIds, branches, excludeBots, authorUserIds

**Caveats**

- Commit counts reflect squash-versus-merge policy far more than effort. This metric exists to explain other metrics, not to evaluate anybody.

**Verified against the metric test dataset**

Expected value `2` from 14 observations. Derivation: 7 non-bot PRs x 2 commits = 14 commits over a 7-day window = 2.0/day; the bot PR's commits are excluded

## Filters

| Filter | Default | Effect |
| --- | --- | --- |
| `repositoryIds` | all | Restrict to specific repositories. |
| `teamIds` | all | Restrict to repositories owned by specific teams. |
| `branches` | all | Restrict to specific branches (base branch for pull requests, head branch for CI runs). |
| `authorUserIds` | all | Restrict to specific authors. Available for personal views; never used to rank people. |
| `excludeBots` | `true` | Exclude bot-authored pull requests and commits. Dependency bots otherwise dominate throughput and size. |
| `productionOnly` | `true` | Restrict deployment metrics to production environments. |

Two numbers computed with different filters are not comparable. Every export embeds the filters that produced it, and
the dashboard keeps them in the URL so a filtered view can be shared as a link.


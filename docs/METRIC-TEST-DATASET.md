# The metric test dataset

A dataset small enough that every expected value was derived by hand, and large enough to exercise every branch of the
metric engine. The engine is checked against these numbers, not against its own previous output. If a metric definition
changes, a human has to re-derive the expectation, which is the point.

Defined in `packages/demo-data/src/fixture.ts`. Asserted in `tests/integration/metrics.test.ts`.

## Setup

One organization (`fixture-co`), one repository (`fixture-co/app`), one team, three developers (`alice`, `bob`,
`carol`) and one bot (`dependabot[bot]`).

Window under test: **2026-03-01T00:00:00Z → 2026-03-08T00:00:00Z** (exactly 7 days), at organization scope, with the
default filters (`excludeBots: true`, `productionOnly: true`).

## Pull requests

| # | Author | Ready for review | Merged | Closed | Size (lines) | Reviews (reviewer, state, requested → submitted) |
| --- | --- | --- | --- | --- | ---: | --- |
| 1 | alice | Mar 1 00:00 | Mar 1 04:00 | — | 100 | bob commented (00:00 → 01:00); bob approved (00:00 → 03:00) |
| 2 | bob | Mar 2 00:00 | Mar 2 10:00 | — | 200 | carol approved (00:00 → 06:00) |
| 3 | carol | Mar 3 00:00 | Mar 3 08:00 | — | 300 | alice commented (00:00 → 01:00); bob approved (00:00 → 02:00) |
| 4 | alice | Mar 4 00:00 | Mar 4 20:00 | — | 50 | carol approved (00:00 → 12:00) |
| 5 | bob | Mar 5 00:00 | Mar 5 06:00 | — | 400 | alice approved (00:00 → 03:00) |
| 6 | dependabot[bot] | Mar 6 00:00 | Mar 6 01:00 | — | 999 | none |
| 7 | carol | Mar 6 00:00 | — | — | 150 | bob commented (00:00 → 05:00) |
| 8 | alice | Mar 7 00:00 | — | Mar 7 06:00 | 250 | none (reopened once) |

PR 6 is bot-authored and excluded from every metric by default. PR 7 is open: it contributes to time-to-first-review but
not to cycle time. PR 8 is the only reopened pull request.

Each pull request has two commits, both committed inside the window. For pull requests 1–5, the first commit is authored
early enough to produce the documented lead time.

## CI

30 conclusive runs: 24 `success`, 6 `failure`. 15 queue for 1 minute and run for 4; 15 queue for 3 minutes and run for
8. Two additional runs are `cancelled` with no start time — they carry no signal about whether the build works and are
excluded from both sides of the success rate.

## Deployments

12 production deployments: 10 `success` (5 linked to pull requests 1–5, 5 unlinked), 2 `failure`. Plus 20 staging
deployments which must not leak into any DORA metric.

## Expected values

| Metric | Expected | Sample | Derivation |
| --- | ---: | ---: | --- |
| PR cycle time | 8 h | 5 | merged non-bot PRs → [4, 10, 8, 20, 6]; median = 8 |
| PR cycle time (mean) | 9.6 h | 5 | (4+10+8+20+6)/5 = 48/5 |
| Time to first review | 4 h | 6 | PRs 1–5 and 7 → [1, 6, 1, 12, 3, 5]; sorted [1,1,3,5,6,12]; median = (3+5)/2 |
| Review turnaround time | 3 h | 8 | all 8 non-self reviews → sorted [1,1,2,3,3,5,6,12]; median = (3+3)/2 |
| Merge time | 4 h | 5 | merged_at − first_approval_at → [1,4,6,8,3]; sorted [1,3,4,6,8]; median = 4 |
| PR size | 200 lines | 7 | non-bot PRs created in window → sorted [50,100,150,200,250,300,400] |
| Review participation | 1.2 per PR | 5 | distinct non-author reviewers per merged PR → [1,1,2,1,1]; mean = 6/5 |
| Reopened PR rate | **Insufficient data** | 6 | 6 closed/merged non-bot PRs < minimum of 20. The true ratio would be 1/6. |
| Build success rate | 0.8 | 30 | 24 success / (24 + 6 failure); 2 cancelled excluded from both sides |
| Build duration | 6 min | 30 | 15 runs of 4 min, 15 of 8 min; median = (4+8)/2 |
| CI queue time | 2 min | 30 | 15 queued 1 min, 15 queued 3 min; median = (1+3)/2 |
| Deployment frequency | 1.4286 /day | 10 | 10 successful production deployments over 7 days; 20 staging excluded |
| Failed deployment rate | 0.1667 | 12 | 2 failed / 12 production |
| Lead time for changes | 30 h | 5 | PR-linked production deployments → [10,20,30,40,50]; 5 unlinked excluded |
| Commit frequency | 2.0 /day | 14 | 7 non-bot PRs × 2 commits = 14 over 7 days |

## What each expectation is there to catch

- **Reopened PR rate** is the only one that expects `insufficient_data`. It exists so the minimum-sample path is
  exercised with a metric whose true value is perfectly computable — the engine must still decline to report it.
- **Build success rate** pins the treatment of cancelled runs. Including them in the denominator would give 0.75.
- **Deployment frequency** pins environment filtering. Including staging would give 4.29/day.
- **Lead time for changes** pins both the exclusion of unlinked deployments and the reporting of how many were excluded.
- **Time to first review** has a different sample size (6) from cycle time (5), because an open pull request can be
  reviewed but not merged. A metric engine that shares one row set between them gets this wrong.
- **PR size** is anchored on creation while cycle time is anchored on merge, so the two cover different pull requests in
  the same window.
- **Commit frequency** pins bot exclusion at the commit level rather than only at the pull request level.

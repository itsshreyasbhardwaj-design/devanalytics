# Architecture

## The shape of the problem

Engineering analytics products usually fail in one of three ways. They compute a number two different ways in two
different screens. They fill gaps with zeros so the chart looks continuous. Or they tell you *what* moved without
helping you find out *why*, so the dashboard is admired once and never opened again.

DevAnalytics is built around avoiding those three, and most of the structural decisions below follow from that.

## Pipeline

```
GitHub / GitLab / CircleCI / Jenkins
              │
              ▼
   ┌──────────────────────┐
   │ Webhook receiver     │   verify HMAC over raw bytes
   │                      │   record delivery (hash always, body only if valid)
   │                      │   normalize to canonical events
   │                      │   idempotent insert + enqueue, in one transaction
   └──────────┬───────────┘   target: single-digit milliseconds
              │
              ▼
   ┌──────────────────────┐
   │ Queue                │   Postgres is the system of record
   │                      │   Redis, when present, only fronts it for latency
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │ Worker               │   project events → domain rows (idempotent, order-independent)
   │                      │   schedule only the buckets that event could have changed
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │ Domain tables        │   pull_requests, reviews, workflow_runs, deployments, commits
   └──────────┬───────────┘
              │
              ▼
   ┌──────────────────────┐
   │ Metric engine        │   one fact query per metric
   │                      │   window values, series, breakdowns, snapshots are
   │                      │   different aggregations of those same rows
   └──────────┬───────────┘
              │
      ┌───────┼────────┬──────────────┬─────────────┐
      ▼       ▼        ▼              ▼             ▼
  Snapshots  Anomaly  Change      REST API      AI layer
             detection intelligence  │            │
                        │            ├─ SDK       └─ evidence → grounded answer
                        ▼            └─ MCP
                  Investigations
```

## Packages

| Package | Responsibility |
| --- | --- |
| `core` | Domain types, canonical event model, time windows, the `MetricResult` sum type, RBAC, provider interfaces. No I/O. |
| `db` | Schema, migrations, driver abstraction (embedded Postgres and node-postgres), org-scoped access, secret encryption. |
| `event-ingestion` | Webhook receiver, idempotency, queue, projector, worker, provider registry. |
| `github` | GitHub webhook adapter and REST backfill. The only GitHub-aware code in the system. |
| `gitlab` | GitLab webhook adapter and REST/GraphQL backfill. The only GitLab-aware code in the system. |
| `circleci` | CircleCI webhook adapter and API v2 backfill. CI-only: its events resolve to a repository hosted elsewhere. |
| `metrics` | Metric registry, fact queries, the analytics engine, snapshots, formatting. |
| `anomaly-detection` | Robust statistics and the detector. Pure functions; no database access. |
| `investigations` | Contribution decomposition, correlation, the investigator, scheduled detection. |
| `ai` | Query planner, evidence collector, grounding verifier, optional LLM narration, guarded SQL. |
| `api` | Framework-agnostic route table, auth, rate limiting, exports. |
| `sdk` | Typed HTTP client. |
| `mcp` | Read-only MCP tools over the SDK. |
| `ui` | Design primitives. |
| `runtime` | Composition root shared by the web app, the API server, the worker and the seed scripts. |
| `demo-data` | The hand-derived metric test dataset and the seeded demo organization generator. |

`apps/web` (dashboard + API), `apps/api` (standalone API) and `apps/worker` all build their object graph from `runtime`,
so there is one wiring, not four.

## Decisions worth explaining

### One definition per metric

Each metric compiles to a single *fact query* whose rows are the individual observations behind it: a timestamp, a
value, and a numerator/denominator contribution. A window value is that query aggregated; a time series is it grouped by
bucket; a breakdown is it grouped by dimension; a snapshot is a bucket persisted. There is no second implementation of
"cycle time" for the chart and the tile to disagree about.

### Insufficient data is a value, not an absence

`MetricResult` is `{ status: 'ok', value, sampleSize } | { status: 'insufficient_data', reason, sampleSize,
minimumSampleSize }`. Every consumer — API, SDK, dashboard, MCP, AI — has to handle both branches to render anything,
which is what structurally prevents a fabricated statistic. Charts break the line at those periods and shade them,
because connecting across a gap asserts a value we declined to measure.

### Tenant isolation lives in the database

Every tenant table carries `org_id` and a row-level security policy keyed on a session setting. Application connections
run as `devanalytics_app`, a non-superuser role, so the policy is enforced by Postgres rather than by remembering to
write a predicate. With no organization set, every policy evaluates false and queries return zero rows: the failure mode
is emptiness, not leakage.

A second role, `devanalytics_ro`, holds `SELECT` and nothing else, and has no grant at all on credential tables. It
backs the AI analytics path.

This has a performance consequence worth knowing: the policy adds an `org_id` predicate to every scan, so **every index
must lead with `org_id`**. An index keyed only on a join column leaves the planner combining two indexes and reading the
organization's whole table on each iteration of a lateral join. Benchmarking found two of these; see migrations 0006 and
0007.

### Webhooks do no analytics

The request path verifies, records, normalizes, inserts and enqueues. Everything expensive happens in the worker. A
handler that computed metrics inline would time out under a backfill or a monorepo's CI volume, and the provider would
start disabling the hook.

Idempotency is the boundary where webhooks, provider redeliveries and REST backfill collide by design: all three produce
canonical events with the same key for the same fact, and the insert is `on conflict do nothing`. The event row and its
queue job commit together, so an accepted event always has scheduled work.

### Projection is order-independent

Events arrive late and out of order. Merge rules use `least(...)` for first-occurrence timestamps, `greatest(...)` for
monotonic counters and `coalesce(...)` for terminal states, so a late `closed` event cannot undo a merge and replaying
the log produces the same tables.

### Incremental, not full, recompute

An event schedules refreshes only for the day, week and month buckets containing its own timestamp, for the repository
it touched. Snapshots store sufficient statistics (numerator, denominator, sample size) so aggregatable metrics can be
rebuilt for a week by summing its days. Median metrics are excluded from that path and recomputed from facts.

### Detection uses each scope's own history

No fixed thresholds: "cycle time over 48 hours" is meaningless across repositories. Baselines are the median and median
absolute deviation of that scope's prior periods, which a minority of extreme values cannot move. Rate metrics use a
two-proportion test instead, so 3-of-4 and 300-of-400 are not treated as equal evidence. A detection must clear both
statistical significance and a minimum effect size, and carries its sample sizes and a confidence grade. Non-detections
are returned with the reason they did not fire, so "we looked and found nothing" is a reportable answer.

### Change intelligence decomposes, it does not correlate-and-guess

For any metric of the form `sum(numerator) / sum(denominator)`, the aggregate is a denominator-weighted average of its
groups, so the change decomposes exactly:

```
ΔM = Σ_g ( w_g,cur · m_g,cur − w_g,base · m_g,base )
```

and each group's term splits into a **rate effect** (the group's own values changed) and a **mix effect** (the group's
share of volume changed). A repository whose reviews got slower and one that merely started producing more of the
organization's pull requests look identical in a naive breakdown and need different responses. The residual is reported
so a bad decomposition is visible rather than silent.

Related metrics are examined from a fixed, auditable list per metric — written down in `packages/investigations/src/related.ts`
— rather than whatever happened to correlate. Candidates that did not move are reported too; showing only the movers
turns an investigation into a search for a story.

### The AI layer never sees the database

```
question → structured plan → analytics engine → evidence bundle → answer
```

The planner maps a question onto a closed set of intents and a metric that exists in the registry. The plan is executed
by the same engine the dashboard uses. The result is a numbered list of citable facts, each naming its metric, scope,
window and sample size. A model, when configured, only rewrites that material into prose — and its output is discarded
unless every magnitude in it appears in the evidence and it makes no causal claim.

With no API key configured, the deterministic renderer answers from the same evidence. The AI surface works offline and
costs nothing; the model is a writing aid layered on a working analytics engine, not the thing producing numbers.

The natural-language-to-SQL escape hatch has five independent layers, each sufficient alone: a `SELECT`-only role, RLS
scoping, single-statement parsing with string literals stripped, a table allowlist that hides credentials even from the
read-only role, and a statement timeout with a row cap. Every execution is audited.

### Embedded Postgres for development and tests

Local development, CI and the test suite run PGlite — real PostgreSQL 16 compiled to WebAssembly — so there is no Docker
requirement and no mock. Production uses node-postgres against managed Postgres. Both run identical SQL, including
`percentile_cont`, lateral joins and row-level security, so queries are not written twice or to a lowest common
denominator.

PGlite holds a single connection, which makes concurrency the driver's problem: all operations share one mutex, and
`close()` drains outstanding work. Both of those were added after a test surfaced a WASM heap fault.

## Adding a provider

Implement `WebhookAdapter` (signature verification and normalization to canonical events) and optionally
`RepositorySource` (backfill). Register it. Nothing else in the system changes — the metric engine, snapshots, detection,
investigations, API and UI never name a provider.

The event mapping for Jenkins is written down in `packages/event-ingestion/src/providers/planned.ts`, including the
parts that do not map cleanly.

### What GitLab actually cost

GitLab was the first provider added after GitHub, and it is a useful measure of whether the boundary works. It required
no change to ingestion, metrics, detection, investigations or the UI. It required four things inside its own adapter and
one honest change to the schema.

**Timestamps.** GitLab emits three formats, only one of which is ISO-8601: `2017-09-20 08:31:45 UTC`,
`2021-04-28 21:50:00 +0200`, and `2011-12-12T14:27:31+02:00`. V8 happens to parse the first; other engines do not. A
naive `replace(' ', 'T')` would read the second as UTC and shift every duration metric by two hours. All of them pass
through `parseGitLabTimestamp`, which returns null rather than inventing a time.

**Identity.** A merge request has both an `id` (globally unique) and an `iid` (the project-scoped number a human sees).
The canonical `number` is the `iid`; `providerPrId` is the `id`. Using `id` would produce pull request numbers in the
tens of thousands that match nothing a user can find.

**Missing facts.** The merge request webhook has no `merged_at`, no `closed_at` and no diff statistics. Merge time is
taken from the update timestamp of the delivery reporting the merge — accurate to webhook latency, and stated as such.
Diff statistics do not exist in GitLab's REST API at all; backfill fetches them through GraphQL `diffStatsSummary`.

**Reconstructed facts.** Pipelines report queue time as a duration in seconds rather than a start timestamp, so the
start is `created_at + queued_duration` — and stays null when GitLab omits the duration. Deployments carry only an
eight-character `short_sha`, which can never match a stored 40-character hash; the full sha is recovered from the last
path segment of `commit_url`, without which no GitLab deployment could be attributed to a merge request and lead time
would exclude all of them. Approvals are system notes rather than a first-class resource, so backfill reconstructs
approval timestamps from the notes feed — GitLab's approvals endpoint reports who approved but not when, and "when" is
the entire content of review latency.

**The schema change.** `pull_requests.additions` was `not null default 0`, which is safe only while every provider
reports diff statistics on every event. GitLab does not, so those columns became nullable and `pr_size` now excludes
unknown sizes and reports the excluded count. This changed something outside the adapter, and it changed it in the
direction the product already required: unknown is not zero.

### What CircleCI cost

CircleCI is the first provider that does not host code, and it broke two assumptions that had held while every provider
was a code host.

**An event is about someone else's repository.** CircleCI identifies a repository by host and path — `gh/acme/api`, or
`https://github.com/acme/api` — and never by GitHub's numeric repository id. Filing its events under a
`provider = 'circleci'` repository would create a second row for a repository that already exists: pull requests would
sit on one and CI runs on the other, and build success rate scoped to the repository a user actually connected would
report no data at all.

So the canonical repository descriptor gained two optional fields. `provider` names the code host when it differs from
the sender, and `isReference` says the descriptor *identifies* a repository rather than describing it — a CI provider
knows a repository's path but not its default branch or visibility, and must not overwrite what the code host recorded.
Resolution is by `(org_id, provider, full_name)`, which migration `0009` makes unique.

The two arrival orders converge on one row. If the code host connects first, CircleCI resolves onto it. If CircleCI
arrives first, it creates a row carrying a placeholder id marked with its provenance (`circleci:acme/api`), and
`upsertRepository` adopts that row by full name when the code host later connects, filling in the real id, default
branch and visibility.

**Queue time is not duration minus start.** `ci_queue_time` was `started_at - created_at`, which assumes the provider
reports when a run was enqueued. CircleCI's payloads report when a workflow was created and when it stopped, and nothing
about waiting for a runner. Setting `created_at` to the workflow's own start would have made queue time a fabricated
zero for every CircleCI run and dragged a mixed organization's median toward it.

`workflow_runs.enqueued_at` is now a separate nullable column and the queue anchor. Null means the provider does not
report it, and those runs are excluded. Build duration is unaffected, because it measures `completed_at - started_at`
and CircleCI does report the interval it actually measures. A unit test asserts every adapter states an enqueue time
explicitly, present or null — an adapter that simply forgot the field would be indistinguishable from one that
deliberately reports none, and would vanish from the metric silently.

**Linking runs to pull requests.** CircleCI reports a branch and a revision, never a pull request number. The projector
falls back to the commit: a run whose head sha belongs to a commit on a pull request is linked through it. This also
benefits GitLab branch pipelines.

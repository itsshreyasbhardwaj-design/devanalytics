# DevAnalytics

**Engineering intelligence that tells you what changed, what accounts for it, and what it cannot tell you.**

DevAnalytics ingests real development events — pull requests, reviews, commits, CI runs, deployments — normalizes them
into a provider-neutral model, computes engineering metrics from them, detects statistically unusual movements against
each scope's own history, and decomposes those movements into the slices that arithmetically account for them.

It is not a dashboard with invented numbers. Every figure is computed from ingested rows or reported as
**"Insufficient data"** with the observation count. That is enforced by the type system, not by discipline.

[![CI](https://github.com/itsshreyasbhardwaj-design/devanalytics/actions/workflows/ci.yml/badge.svg)](https://github.com/itsshreyasbhardwaj-design/devanalytics/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](./LICENSE)

---

## The problem

Engineering metrics tools tend to fail the same three ways.

**They fabricate.** A week with four merged pull requests gets a cycle-time number plotted with the same confidence as
a week with four hundred. Gaps are filled with zeros so the chart looks continuous, and a period nobody measured becomes
a period that looks like nothing happened.

**They disagree with themselves.** The tile says 12 hours, the chart says 9, the export says something else again,
because three code paths compute "the same" metric with slightly different anchors and filters.

**They stop at the observation.** "Cycle time is up 31%" is where the tool ends and the human's week begins. Which
repository? Was it slower, or just busier? What else moved? The dashboard is admired once and never opened again.

DevAnalytics is built to fail none of those.

---

## What it does

### Metrics with contracts

Fifteen metrics, each with a published formula, source tables, time anchor, minimum sample size and caveats. See
[METRICS.md](./METRICS.md) — generated from the same registry the engine reads, so it cannot drift.

Each metric compiles to a single fact query. Window values, time series, breakdowns and snapshots are different
aggregations of those same rows, so the tile and the chart cannot disagree.

### Insufficient data is a value

```ts
type MetricResult =
  | { status: 'ok'; value: number; sampleSize: number }
  | { status: 'insufficient_data'; reason: string; sampleSize: number; minimumSampleSize: number };
```

Every consumer — API, SDK, dashboard, MCP, AI — must handle both branches to render anything. Charts break the line at
those periods and shade them, because connecting across a gap asserts a value that was never measured.

### Change intelligence

When a metric moves, the platform decomposes the delta exactly:

```
ΔM = Σ_g ( w_g,cur · m_g,cur − w_g,base · m_g,base )
```

Each group's share splits into a **rate effect** (the group's own values changed) and a **mix effect** (the group's
share of volume changed). Those need different responses, and a naive breakdown cannot tell them apart. The residual is
reported so a bad decomposition is visible.

Related metrics are examined from a fixed, auditable list per metric, and the ones that *didn't* move are reported too.
Everything is worded as association:

> northwind/checkout accounts for 87.8% of the change, driven by its own values changing rather than by its share of
> volume. Time to first review moved +30.4% over the same period and shows a weak correlation with the change (r = 0.43
> across 36 buckets).

A regex guard makes causal phrasing throw at generation time rather than ship.

### Anomaly detection without thresholds

"Cycle time over 48 hours" is meaningless across repositories. Baselines are the median and median absolute deviation of
that scope's own prior periods. Rate metrics use a two-proportion test, so 3-of-4 and 300-of-400 are not treated as
equal evidence. A detection must clear both statistical significance and a minimum effect size, and carries its sample
sizes and a confidence grade. Non-detections are returned with the reason they did not fire.

### AI grounded in evidence

```
question → structured plan → analytics engine → evidence bundle → answer
```

No schema and no rows ever reach a model. The planner maps a question onto a closed set of intents and a metric that
exists in the registry; the analytics engine executes it; the result is a numbered list of citable facts, each naming
its metric, scope, window and sample size.

A model, when configured, only rewrites that material into prose — and its output is **discarded** if it contains a
figure absent from the evidence or makes a causal claim. With no API key configured, the deterministic renderer answers
from the same evidence: the AI surface works offline and costs nothing.

```
$ curl -XPOST localhost:3117/api/v1/ai/query -d '{"question":"Why did PR cycle time increase?"}'
{ "generatedBy": "deterministic", "grounding": { "grounded": true, "checked": 38 }, "citations": [...] }
```

---

## Screens

| | |
| --- | --- |
| **Overview** | Delivery, review, CI and deployment metrics with period comparison |
| **Repositories** | Per-repository health as named metrics — deliberately not one opaque score |
| **Teams** | Team aggregation. No individual rankings anywhere, [by design](#no-individual-rankings) |
| **Pull requests** | Full timeline per PR: commits, reviews, comments, CI runs, deployments |
| **CI** | Success rate, duration and queue time reported separately |
| **Deployments** | Frequency, lead time, failure rate, with exclusions surfaced |
| **Anomalies** | Score, severity, confidence and both sample sizes |
| **Investigations** | Contribution decomposition and associated metrics |
| **Metrics** | Every definition, formula and caveat |
| **Ask** | Questions answered from evidence, with citations |
| **Data explorer** | Raw canonical events, delivery signatures, queue depth |
| **Settings** | Connections, tokens, providers, runtime state |

Global filters (period, repository, team, bots, production-only) live in the URL, so a filtered view is a link you can
paste into an incident channel. `Cmd/Ctrl + K` searches repositories, metrics and pull requests.

---

## Quick start

Requires Node 20.11+ and pnpm. **No Docker, no database server, no API keys.**

```bash
pnpm install
pnpm demo:seed            # generates a labelled demo organization and prints its id
```

The seed prints the exact command to run next:

```bash
DEVANALYTICS_AUTH_MODE=local-dev DEVANALYTICS_LOCAL_ORG_ID=<id> pnpm dev
```

Then open http://localhost:3117.

Local development and the test suite run **PGlite** — real PostgreSQL 16 compiled to WebAssembly — so there is no mock
anywhere. Production uses node-postgres against managed Postgres or Supabase; both run identical SQL.

Demo organizations are created with `is_demo = true`, and every surface checks that flag and labels the page.

### Connecting a real repository

```bash
export DEVANALYTICS_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export DATABASE_URL=postgresql://...        # optional; embedded engine is the default
pnpm db:migrate
```

Create a webhook endpoint through the API, then point a GitHub webhook at the URL it returns and subscribe to:

```
push, pull_request, pull_request_review, pull_request_review_comment,
workflow_run, deployment, deployment_status
```

Run the worker alongside the app:

```bash
pnpm worker
```

---

## API

Documented at `/api/v1/openapi.json`. Authenticate with `Authorization: Bearer dva_...`.

```
GET  /api/v1/metrics                        every definition
GET  /api/v1/metrics/:metric/value          value over a window
GET  /api/v1/metrics/:metric/compare        vs the preceding equal-length window
GET  /api/v1/metrics/:metric/series         bucketed history
GET  /api/v1/metrics/:metric/breakdown      by repository, team, branch or author
GET  /api/v1/metrics/:metric/facts          the individual observations
GET  /api/v1/repositories/:id/health        named health metrics
GET  /api/v1/pull-requests/:id              full timeline
GET  /api/v1/anomalies                      with score, severity, confidence, sample sizes
POST /api/v1/investigations                 run and persist an investigation
POST /api/v1/ai/query                       question → grounded answer with citations
POST /api/v1/ai/sql                         guarded read-only SELECT
GET  /api/v1/export/metrics/:metric         CSV or JSON, definition embedded
GET  /api/v1/export/investigations/:id      Markdown or PDF
POST /api/v1/webhooks/:provider/:endpointId provider receiver
```

## SDK

```ts
import { DevAnalytics } from '@devanalytics/sdk';

const client = new DevAnalytics({ apiKey: process.env.DEVANALYTICS_API_KEY! });

const cycle = await client.metrics.get('pr_cycle_time', { period: '30d' });
if (cycle.result.status === 'ok') {
  console.log(`${cycle.result.value} hours from ${cycle.result.sampleSize} pull requests`);
} else {
  console.log(`Insufficient data: ${cycle.result.sampleSize}/${cycle.result.minimumSampleSize}`);
}

const contributors = await client.metrics.breakdown('pr_cycle_time', 'repository', { period: '30d' });
const open = await client.anomalies.list({ status: 'open' });
const answer = await client.ai.query('Why did PR cycle time increase?');
```

The SDK does not normalise `insufficient_data` away — a chart built on it cannot plot a missing period as zero.

## MCP server

Seventeen read-only tools for AI agents.

```json
{
  "mcpServers": {
    "devanalytics": {
      "command": "npx",
      "args": ["-y", "@devanalytics/mcp"],
      "env": {
        "DEVANALYTICS_API_KEY": "dva_...",
        "DEVANALYTICS_BASE_URL": "https://devanalytics.example.com"
      }
    }
  }
}
```

`list_metrics`, `get_metric`, `compare_metric`, `get_metric_series`, `get_repository_metrics`, `list_repositories`,
`get_pr_metrics`, `get_ci_metrics`, `get_deployment_metrics`, `breakdown_metric`, `list_anomalies`, `get_investigation`,
`list_investigations`, `search_engineering_events`, `list_pull_requests`, `get_pull_request`, `ask_devanalytics`.

The server refuses to start if a mutating tool is ever registered. Use a `viewer`-role token so the credential itself
cannot write, independently of the tools exposed.

---

## Security

| Control | Implementation |
| --- | --- |
| Tenant isolation | Postgres row-level security on every tenant table, under a non-superuser role. No org set ⇒ zero rows. |
| Least privilege | `devanalytics_app` (read/write) and `devanalytics_ro` (SELECT only, no grant on credential tables). |
| Webhook authenticity | HMAC-SHA256 over raw bytes, constant-time comparison, before parsing. Rejected bodies are not stored. |
| Secrets at rest | AES-256-GCM with a versioned, rotatable format. Never returned by any endpoint. |
| API tokens | Only a SHA-256 is stored; the plaintext is shown once. |
| Host credentials | Server-side only. No provider token ever reaches a browser. |
| RBAC | Four roles, per-organization. Cross-organization access is not expressible in the data model. |
| AI SQL | Five independent layers: read-only role, RLS scope, single-statement parsing, table allowlist, timeout + row cap. Every execution audited. |
| Rate limiting | Token bucket per principal, with heavier costs for AI and export endpoints. |
| Audit log | Exports, investigations, AI queries, SQL attempts (accepted and rejected), anomaly acknowledgements. |

See [SECURITY.md](./SECURITY.md).

### No individual rankings

Team and repository aggregation exist; individual leaderboards do not, and adding one would require changing the data
model rather than adding a screen.

Engineering metrics measure a process, not a person. Cycle time depends on who was free to review, how large the change
was, how long CI took and what else was in flight — almost none of which the author controls. Ranking individuals on
these numbers reliably produces smaller pull requests, more of them, and reviewers who approve without reading. The
metric improves; the engineering does not. Signed-in users can see their own activity, which is useful to them and to
nobody else.

---

## Testing

```bash
pnpm test              # 219 unit + integration + security tests
pnpm test:e2e          # 22 Playwright tests against a production build
pnpm typecheck
pnpm lint
pnpm a11y              # contrast, heading order, landmarks, accessible names
pnpm bench
```

**219 unit, integration and security tests, plus 22 end-to-end tests.** Every integration and security test runs
against a real, freshly-migrated PostgreSQL 16. The end-to-end suite runs against a production build and authenticates
with a real API token, not a development bypass.

The metric engine is verified against a dataset whose fifteen expected values were **derived by hand**, not recorded
from the engine's own output — see [docs/METRIC-TEST-DATASET.md](./docs/METRIC-TEST-DATASET.md). Change intelligence is
verified against a generated dataset with a *planted* regression: the investigation must attribute the movement to the
right repository for the right reason.

Accessibility is audited across all thirteen pages for WCAG AA contrast, heading order, landmarks and accessible names
(`pnpm a11y`). All pass.

Security tests cover webhook spoofing (unsigned, wrongly signed, wrong algorithm, wrong endpoint, tampered body),
tenant isolation through the HTTP layer (cross-org reads, scoped metrics, exports, AI answers, secret leakage), SQL
injection against the guard (20 rejected patterns, including keywords hidden in string literals), and exactly which
tables each database role may reach.

## Benchmarks

Methodology is stated in `scripts/benchmark.ts`: fresh embedded Postgres per run, discarded warmup iterations, p50/p95
rather than means, no caching layer. On a 180-day dataset (9,421 domain rows), Node 24, darwin/arm64:

| Benchmark | p50 | p95 |
| --- | ---: | ---: |
| Webhook accept (verify + persist + enqueue) | 189 ops/s | — |
| PR cycle time, 30 days | 6.7 ms | 8.3 ms |
| PR cycle time, 90 days | 11.2 ms | 12.5 ms |
| Lead time for changes, 90 days (lateral join) | 8.0 ms | 9.4 ms |
| All 15 metrics, 30 days | 77.5 ms | 84.8 ms |
| Time series, weekly over 365 days | 12.9 ms | 13.7 ms |
| Breakdown by repository, 90 days | 7.0 ms | 10.5 ms |
| Snapshot materialisation | 1,287 buckets/s | — |
| Full investigation (4 dimensions, 7 related metrics) | 259.7 ms | 381.0 ms |

Benchmarking found a real defect: under row-level security, Postgres adds an `org_id` predicate to every scan, so an
index that does not lead with `org_id` leaves the planner combining two indexes and reading the organization's whole
table per lateral-join iteration. Fixing that took lead time for changes from 155 ms to 8 ms and review participation
from 125 ms to 7 ms. See migrations `0006` and `0007`.

---

## Stack

Next.js App Router · React 19 · TypeScript (strict, `noUncheckedIndexedAccess`) · Tailwind · Recharts · PostgreSQL 16
(PGlite embedded / node-postgres managed) · Redis-optional durable queue · Clerk-compatible auth · OpenRouter-optional
AI · Vitest · Playwright · pnpm workspaces

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — pipeline, packages, and why each decision was made
- [METRICS.md](./METRICS.md) — every metric's contract (generated)
- [docs/METRIC-TEST-DATASET.md](./docs/METRIC-TEST-DATASET.md) — the hand-derived fixture
- [SECURITY.md](./SECURITY.md) · [CONTRIBUTING.md](./CONTRIBUTING.md) · [CHANGELOG.md](./CHANGELOG.md)

## Roadmap

- GitLab, CircleCI and Jenkins adapters — event mappings already written down, including where they do not map cleanly
- Incident data for a true DORA change failure rate (the current `failed_deployment_rate` is a lower bound and says so)
- Per-branch snapshot scopes
- Alerting on anomalies (webhook, Slack)
- Working-hours calendars as an optional lens on duration metrics

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). The one rule worth stating here: **a metric that cannot be computed from
ingested data must return `insufficient_data`.** A pull request that makes a number appear where there was none will be
declined regardless of how good the chart looks.

## License

Apache 2.0 — see [LICENSE](./LICENSE).

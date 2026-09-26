# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **GitLab provider.** Webhook adapter (push, merge requests, approvals, diff notes, pipelines, deployments) and
  REST/GraphQL backfill, registered alongside GitHub. Metrics, detection, investigations and the dashboard span both
  providers with no provider-aware code outside the adapters.
- GitLab-specific handling for things the canonical model does not assume: three timestamp formats, `iid` versus `id`,
  bearer-token authentication instead of a body signature, pipeline queue time reported as a duration rather than a
  start time, deployment `short_sha` resolved to a full sha via `commit_url`, and approval timestamps reconstructed from
  system notes because GitLab's approvals endpoint reports who but not when.
- `pr_size` now reports how many pull requests it excluded for unknown size, the way lead time already reported
  unattributable deployments.
- 71 tests covering the adapter, the backfill source, mixed-provider ingestion and GitLab webhook spoofing.

### Changed

- **`pull_requests.additions`, `deletions` and `changed_files` are nullable** (migration `0008`). They were
  `not null default 0`, which is safe only while every provider reports diff statistics on every event. GitLab's merge
  request webhook carries none, so a GitLab repository would have recorded every merge request as zero lines changed and
  PR size would have reported a median dragged toward zero. Null means "not reported"; `pr_size` excludes those rows.
  `greatest()` already ignores nulls, so a later event that does carry statistics still wins.

## [0.1.0] — 2026-09-26

First public release.

### Added

**Ingestion**
- GitHub webhook receiver with HMAC-SHA256 verification over raw request bytes and constant-time comparison
- Canonical, provider-neutral event model; GitHub is the first implementation, not the model
- Idempotent event insert shared by webhooks, provider redeliveries and REST backfill
- Durable Postgres job queue with `for update skip locked`, exponential backoff and an optional Redis front
- Order-independent projection: a late close cannot undo a merge
- Architected adapter interfaces and written event mappings for GitLab, CircleCI and Jenkins

**Analytics**
- Fifteen metrics, each with a published formula, data source, time anchor, minimum sample size and caveats
- One fact query per metric; window values, series, breakdowns and snapshots are aggregations of the same rows
- `MetricResult` sum type — `insufficient_data` is a value every consumer must handle
- Incremental snapshots with sufficient statistics; medians correctly excluded from the aggregatable path
- Day, week and month granularity over 1d/7d/30d/90d/365d windows with previous-period comparison

**Change intelligence**
- Anomaly detection on robust median/MAD baselines, with a two-proportion test for rate metrics
- Both statistical and practical significance gates; non-detections report why they did not fire
- Exact contribution decomposition splitting rate effects from mix effects, with the residual reported
- Investigations that examine a fixed, auditable list of related metrics and report the ones that did not move
- Causal-language guard that throws at generation time

**AI**
- Structured query planner over the metric registry; no model writes a database query
- Evidence bundles where every citation names its metric, scope, window and sample size
- Grounding verification that discards model output containing unsupported figures or causal claims
- Deterministic renderer so the AI surface works with no API key and no cost
- Guarded read-only SQL with five independent safety layers, fully audited

**Interfaces**
- Twelve-section dashboard with URL-based global filters and a command palette
- Charts that break at insufficient-data periods rather than interpolating across them
- REST API with an OpenAPI document, typed TypeScript SDK, read-only MCP server with seventeen tools
- CSV, JSON, Markdown and PDF export with metric definitions embedded

**Security**
- Postgres row-level security under two least-privilege roles
- AES-256-GCM secret storage, hashed API tokens, four-role RBAC, rate limiting, audit logging

**Verification**
- 219 unit, integration and security tests against real PostgreSQL 16, plus 22 end-to-end tests against a production build
- Metric engine checked against fifteen hand-derived expected values
- Change intelligence checked against a dataset with a planted regression
- Benchmark suite with a stated methodology

### Fixed during development

- Embedded driver serialised transactions but not standalone queries, so overlapping queries on its single connection
  could fault the WASM heap. All operations now share one mutex and `close()` drains outstanding work.
- Indexes that did not lead with `org_id` forced the planner into a BitmapAnd under row-level security, reading the
  organization's whole table per lateral-join iteration. Lead time for changes went from 155 ms to 8 ms, review
  participation from 125 ms to 7 ms.
- The grounding verifier rejected the product's own deterministic answers, because citation statements quoted figures
  absent from their `values`. The supported set is now derived from statements and registry caveats as well.
- The read-only database role correctly denied the settings page access to webhook secrets. `api_tokens` and
  `org_members` were revoked from that role too, with tests covering exactly what it may reach.
- The production Content-Security-Policy blocked React Refresh in development, preventing all client hydration.
  `unsafe-eval` is now development-only.
- Rate-limit buckets were keyed on the principal alone, so every policy shared one bucket. Because capacity is applied
  on refill, the smallest policy's capacity became the ceiling for all of them and roughly twenty page loads exhausted
  the AI allowance. Buckets are now per principal and policy.
- Five text styles fell below the WCAG AA contrast minimum, including sample sizes and metric formulas, and card titles
  skipped a heading level on ten pages. Both fixed; `pnpm a11y` now audits every page.

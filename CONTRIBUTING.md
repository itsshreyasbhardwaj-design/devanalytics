# Contributing

## The rule that matters

**A number must be computed from ingested data, or reported as `insufficient_data`.**

There is no third option. A pull request that makes a value appear where there was none — a zero-filled gap, an
interpolated point, an estimate, a "reasonable default" — will be declined regardless of how much better the chart
looks. If you find a place where the product violates this, that is a bug report we want.

## Getting set up

Node 20.11+, pnpm. No Docker, no database server, no API keys.

```bash
pnpm install
pnpm demo:seed
DEVANALYTICS_AUTH_MODE=local-dev DEVANALYTICS_LOCAL_ORG_ID=<printed id> pnpm dev
```

## Before opening a pull request

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

If you touched a metric definition, also `pnpm docs:metrics`. If you touched a `.sql` migration, also `pnpm db:gen` —
a test fails when the generated module drifts from the files.

## Adding a metric

1. Add it to `packages/metrics/src/definitions.ts` with a real formula, data source, time anchor, minimum sample size
   and honest caveats. The caveats are not boilerplate: write what a reader must know before acting on the number.
2. Add its fact query to `packages/metrics/src/facts.ts`.
3. **Derive its expected value by hand** from `packages/demo-data/src/fixture.ts` and add it to `FIXTURE_EXPECTATIONS`
   with the derivation written out. Do not record the engine's output — the test exists to catch the engine being
   wrong, which it cannot do if the expectation came from the engine.
4. Add it to `RELATED_METRICS` in `packages/investigations/src/related.ts` where relevant.
5. Run `pnpm docs:metrics`.

If the metric is a median, mark it non-aggregatable. The median of daily medians is not the median, and the snapshot
path must not treat it as one.

## Adding a provider

Implement `WebhookAdapter` and optionally `RepositorySource` from `packages/core/src/provider.ts`, then register it.
Nothing outside your adapter should need to change.

Start by writing the event mapping into `packages/event-ingestion/src/providers/planned.ts`, including the parts that do
**not** map cleanly. A provider that cannot report CI queue time must make that metric return `insufficient_data`, not
zero.

## Adding an index

Every index on a tenant table must lead with `org_id`. Row-level security adds an `org_id` predicate to every scan, so
an index keyed only on a join column leaves the planner combining two indexes and reading the organization's whole
table. This has bitten us twice; see migrations `0006` and `0007`.

## Style

- TypeScript strict, including `noUncheckedIndexedAccess`. No `any`, no non-null assertions on values from the database.
- Comments explain *why*, not what. If a comment restates the code, delete it.
- Tests assert behaviour someone depends on. A test that only pins the current implementation is churn.
- Conventional Commits.

## Things we will push back on

- Individual developer leaderboards. See the reasoning in the README; this is a product decision, not an oversight.
- Causal language in generated narrative. The data is observational. `assertNonCausal` exists to make this fail loudly.
- Caching that can serve a metric computed with different filters than the ones displayed.
- Bundling the database drivers. They must stay external; see the webpack configuration and its comment.

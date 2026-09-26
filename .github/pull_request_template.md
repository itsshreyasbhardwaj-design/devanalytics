## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- What problem does it solve? Link the issue if there is one. -->

## Checks

- [ ] `pnpm typecheck`
- [ ] `pnpm lint`
- [ ] `pnpm test`
- [ ] `pnpm build`

## If you changed a metric

- [ ] `packages/metrics/src/definitions.ts` updated with formula, data source, time anchor, minimum sample and caveats
- [ ] Expected value **derived by hand** and added to `FIXTURE_EXPECTATIONS`, with the derivation written out
- [ ] `pnpm docs:metrics` run
- [ ] Median metrics are marked non-aggregatable

## If you changed the schema

- [ ] `pnpm db:gen` run
- [ ] Every new index on a tenant table leads with `org_id`
- [ ] Row-level security policy and role grants updated for any new table

## Reporting integrity

- [ ] No code path in this change can display a number that was not computed from ingested data
- [ ] Any period below a metric's minimum sample still reports `insufficient_data`
- [ ] No generated text in this change makes a causal claim about observational data

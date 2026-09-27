-- Support for providers that run CI but do not host code.
--
-- Two assumptions held while every provider was a code host, and CircleCI
-- breaks both.
--
-- 1. QUEUE TIME IS NOT DURATION MINUS START.
--
-- `ci_queue_time` was `started_at - created_at`, which assumes the provider
-- reports when a run was enqueued. CircleCI's webhooks do not: they report when
-- a workflow was created and when it stopped, and nothing about waiting for a
-- runner. Setting created_at to the workflow's own start would make queue time
-- a fabricated zero for every CircleCI run and drag a mixed organization's
-- median toward it.
--
-- `enqueued_at` is now the queue anchor and is nullable. Null means the
-- provider does not report it, and ci_queue_time excludes those runs rather
-- than reporting them as instant. `created_at` keeps its job as the row's time
-- anchor, and build duration is unaffected because it measures
-- completed_at - started_at.
alter table workflow_runs add column if not exists enqueued_at timestamptz;

-- Every existing row came from GitHub or GitLab, both of which report the
-- enqueue time as the run's creation time.
update workflow_runs set enqueued_at = created_at where enqueued_at is null;

create index if not exists run_queue_idx
  on workflow_runs (org_id, created_at)
  where enqueued_at is not null and started_at is not null;

-- 2. A REPOSITORY IS IDENTIFIED BY ITS FULL NAME, NOT ONLY BY A HOST ID.
--
-- A CircleCI event knows the repository as "github/acme/api" — a host and a
-- path. It does not know GitHub's numeric repository id, so it cannot be
-- matched on (provider, provider_repo_id), and inserting on that key alone
-- would create a second row for a repository that already exists. Pull
-- requests would then sit on one row and CI runs on the other, and build
-- success rate scoped to the repository a user actually connected would report
-- no data at all.
--
-- Full name is unique per host within an organization, so it is a legitimate
-- secondary key. Keeping the provider in it means a GitHub "acme/api" and a
-- GitLab "acme/api" remain distinct, which they are.
create unique index if not exists repo_provider_fullname_key
  on repositories (org_id, provider, full_name);

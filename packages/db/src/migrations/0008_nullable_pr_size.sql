-- Pull request size becomes "unknown" rather than zero.
--
-- These columns were `not null default 0`, which is safe only while every
-- provider reports diff statistics on every event. GitHub does. GitLab's merge
-- request webhook carries no diff statistics at all, so a GitLab-only
-- deployment would record every merge request as zero lines changed, and PR
-- size would report a median dragged toward zero — a measurement of something
-- that was never measured.
--
-- Null means "this provider did not tell us". The pr_size metric excludes
-- those rows and reports a smaller sample size, which is the honest outcome:
-- a smaller number of real observations rather than a larger number of
-- fabricated ones. Backfill fills them in from the provider's changes API.
--
-- `greatest()` in the upsert merge rule already ignores nulls, so a later
-- event that does carry statistics still wins over an earlier one that did not.
alter table pull_requests alter column additions drop not null;
alter table pull_requests alter column additions drop default;
alter table pull_requests alter column deletions drop not null;
alter table pull_requests alter column deletions drop default;
alter table pull_requests alter column changed_files drop not null;
alter table pull_requests alter column changed_files drop default;

-- Existing rows genuinely recorded zero-line pull requests only if a provider
-- said so; there is no way to distinguish them retroactively, so they are left
-- as they are. New rows carry the distinction.

-- Supports the pr_size fact query, which now filters on size being known.
create index if not exists pr_size_known_idx
  on pull_requests (org_id, created_at)
  where additions is not null and deletions is not null;

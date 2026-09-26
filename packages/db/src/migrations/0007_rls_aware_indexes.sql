-- Remaining indexes rebuilt to lead with org_id.
--
-- Same reasoning as 0006: row-level security adds an org_id predicate to every
-- scan, so an index keyed only on a join column leaves the planner combining
-- two indexes and reading the organization's whole table on each iteration of
-- a lateral join.
--
-- Measured on the 180-day benchmark dataset, review_participation (which joins
-- reviews per pull request) went from ~125 ms to single digits.

drop index if exists review_pr_idx;
create index if not exists review_org_pr_idx
  on reviews (org_id, pull_request_id, reviewer_user_id);

drop index if exists rc_pr_idx;
create index if not exists rc_org_pr_idx
  on review_comments (org_id, pull_request_id, created_at);

drop index if exists run_pr_idx;
create index if not exists run_org_pr_idx
  on workflow_runs (org_id, pull_request_id, created_at)
  where pull_request_id is not null;

drop index if exists dep_pr_idx;
create index if not exists dep_org_pr_idx
  on deployments (org_id, pull_request_id)
  where pull_request_id is not null;

drop index if exists finding_inv_idx;
create index if not exists finding_org_inv_idx
  on investigation_findings (org_id, investigation_id, rank);

drop index if exists event_unprocessed_idx;
create index if not exists event_org_unprocessed_idx
  on events (org_id, occurred_at) where processed_at is null;

-- Deployment attribution matches a deployment sha against a pull request's
-- merge commit; this lets that lookup use an index too.
create index if not exists pr_merge_sha_idx
  on pull_requests (org_id, merge_commit_sha) where merge_commit_sha is not null;

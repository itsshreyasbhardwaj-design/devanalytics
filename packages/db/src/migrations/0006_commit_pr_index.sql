-- Indexes under row-level security must lead with org_id.
--
-- The policy adds `org_id = devanalytics_current_org()` to every scan, so an
-- index keyed only on the join column cannot satisfy the whole predicate. The
-- planner then combines it with a second index in a BitmapAnd and reads every
-- commit in the organization on each iteration of the lateral join.
--
-- Measured on the 180-day benchmark dataset:
--   no index                     ~155 ms
--   index on (pull_request_id)   ~103 ms  (BitmapAnd, 2.7k rows scanned per loop)
--   index below                    ~6 ms
--
-- `authored_at` is included so `min(authored_at)` is answered from the index
-- rather than by visiting the heap.
drop index if exists commit_pr_idx;
create index if not exists commit_org_pr_authored_idx
  on commits (org_id, pull_request_id, authored_at)
  where pull_request_id is not null;

-- Deployment attribution looks a commit up by sha to find its pull request.
create index if not exists commit_sha_lookup_idx on commits (org_id, sha);

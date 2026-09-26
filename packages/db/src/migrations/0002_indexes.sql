-- Indexes chosen from the actual query shapes in packages/metrics.
-- Every analytics read is (org_id, <time column>) with optional repo/author
-- narrowing, so org_id leads every composite index.

create index if not exists pr_org_ready_idx      on pull_requests (org_id, ready_for_review_at) where ready_for_review_at is not null;
create index if not exists pr_org_merged_idx     on pull_requests (org_id, merged_at) where merged_at is not null;
create index if not exists pr_repo_merged_idx    on pull_requests (org_id, repo_id, merged_at) where merged_at is not null;
create index if not exists pr_org_created_idx    on pull_requests (org_id, created_at);
create index if not exists pr_author_idx         on pull_requests (org_id, author_user_id, created_at);
create index if not exists pr_base_branch_idx    on pull_requests (org_id, base_branch, merged_at);
create index if not exists pr_state_idx          on pull_requests (org_id, state, updated_at);

create index if not exists review_pr_idx         on reviews (pull_request_id, submitted_at);
create index if not exists review_org_time_idx   on reviews (org_id, submitted_at);
create index if not exists review_reviewer_idx   on reviews (org_id, reviewer_user_id, submitted_at);

create index if not exists rc_pr_idx             on review_comments (pull_request_id, created_at);

create index if not exists commit_org_time_idx   on commits (org_id, committed_at);
create index if not exists commit_repo_time_idx  on commits (org_id, repo_id, committed_at);
create index if not exists commit_author_idx     on commits (org_id, author_user_id, committed_at);

create index if not exists run_org_created_idx   on workflow_runs (org_id, created_at);
create index if not exists run_repo_created_idx  on workflow_runs (org_id, repo_id, created_at);
create index if not exists run_completed_idx     on workflow_runs (org_id, completed_at) where completed_at is not null;
create index if not exists run_conclusion_idx    on workflow_runs (org_id, conclusion, completed_at);
create index if not exists run_branch_idx        on workflow_runs (org_id, head_branch, created_at);
create index if not exists run_pr_idx            on workflow_runs (pull_request_id) where pull_request_id is not null;

create index if not exists dep_org_created_idx   on deployments (org_id, created_at);
create index if not exists dep_prod_idx          on deployments (org_id, is_production, created_at);
create index if not exists dep_repo_idx          on deployments (org_id, repo_id, created_at);
create index if not exists dep_pr_idx            on deployments (pull_request_id) where pull_request_id is not null;

create index if not exists event_org_time_idx    on events (org_id, occurred_at desc);
create index if not exists event_type_idx        on events (org_id, type, occurred_at desc);
create index if not exists event_repo_idx        on events (org_id, repo_id, occurred_at desc);
create index if not exists event_unprocessed_idx on events (processed_at) where processed_at is null;

create index if not exists snapshot_lookup_idx   on metric_snapshots (org_id, metric, scope_type, scope_id, granularity, bucket_start desc);
create index if not exists snapshot_bucket_idx   on metric_snapshots (org_id, granularity, bucket_start desc);

create index if not exists anomaly_open_idx      on anomalies (org_id, status, detected_at desc);
create index if not exists anomaly_metric_idx    on anomalies (org_id, metric, window_end desc);

create index if not exists investigation_org_idx on investigations (org_id, created_at desc);
create index if not exists finding_inv_idx       on investigation_findings (investigation_id, rank);

create index if not exists queue_poll_idx        on job_queue (queue, available_at) where completed_at is null;
create index if not exists audit_org_idx         on audit_log (org_id, created_at desc);
create index if not exists delivery_time_idx     on webhook_deliveries (received_at desc);
create index if not exists users_login_idx       on users (org_id, login);
create index if not exists repo_fullname_idx     on repositories (org_id, full_name);

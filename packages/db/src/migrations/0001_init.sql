-- DevAnalytics core schema.
--
-- Isolation model: every tenant-scoped table carries org_id and is protected by
-- a row-level security policy keyed on the `devanalytics.org_id` session setting.
-- Application connections run as the non-superuser role `devanalytics_app`, so
-- the policy is enforced by Postgres rather than by application discipline.
-- With no org set, every policy evaluates false and queries return zero rows.

create table if not exists schema_migrations (
  version     text primary key,
  applied_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------- identity --

create table if not exists organizations (
  id          text primary key,
  slug        text not null unique,
  name        text not null,
  is_demo     boolean not null default false,
  created_at  timestamptz not null default now()
);

-- Authenticated humans. Global, because one person may belong to many orgs.
create table if not exists principals (
  id              text primary key,
  auth_provider   text not null,
  auth_subject    text not null,
  email           text,
  display_name    text,
  created_at      timestamptz not null default now(),
  unique (auth_provider, auth_subject)
);

create table if not exists org_members (
  org_id        text not null references organizations(id) on delete cascade,
  principal_id  text not null references principals(id) on delete cascade,
  role          text not null check (role in ('owner','admin','member','viewer')),
  created_at    timestamptz not null default now(),
  primary key (org_id, principal_id)
);

create table if not exists api_tokens (
  id             text primary key,
  org_id         text not null references organizations(id) on delete cascade,
  principal_id   text not null references principals(id) on delete cascade,
  name           text not null,
  -- Only the hash is stored; the plaintext token is shown once at creation.
  token_hash     text not null unique,
  token_prefix   text not null,
  role           text not null check (role in ('owner','admin','member','viewer')),
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz,
  revoked_at     timestamptz
);

create table if not exists teams (
  id       text primary key,
  org_id   text not null references organizations(id) on delete cascade,
  slug     text not null,
  name     text not null,
  unique (org_id, slug)
);

-- Developers as seen by the code host. Distinct from `principals`: most people
-- who appear in engineering data never log into DevAnalytics.
create table if not exists users (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  provider          text not null,
  provider_user_id  text not null,
  login             text not null,
  name              text,
  is_bot            boolean not null default false,
  unique (org_id, provider, provider_user_id)
);

create table if not exists team_members (
  team_id  text not null references teams(id) on delete cascade,
  user_id  text not null references users(id) on delete cascade,
  org_id   text not null references organizations(id) on delete cascade,
  primary key (team_id, user_id)
);

-- ------------------------------------------------------------ repositories --

create table if not exists repositories (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  provider          text not null,
  provider_repo_id  text not null,
  name              text not null,
  full_name         text not null,
  default_branch    text not null default 'main',
  is_private        boolean not null default true,
  team_id           text references teams(id) on delete set null,
  archived_at       timestamptz,
  connected_at      timestamptz not null default now(),
  unique (org_id, provider, provider_repo_id)
);

-- Per-repository connection secrets. Webhook secrets and host tokens are
-- encrypted at rest with the deployment key and never leave the server.
create table if not exists repo_connections (
  id                    text primary key,
  org_id                text not null references organizations(id) on delete cascade,
  repo_id               text not null references repositories(id) on delete cascade,
  provider              text not null,
  webhook_secret_enc    text,
  access_token_enc      text,
  installation_id       text,
  created_at            timestamptz not null default now(),
  unique (repo_id, provider)
);

create table if not exists branches (
  id          text primary key,
  org_id      text not null references organizations(id) on delete cascade,
  repo_id     text not null references repositories(id) on delete cascade,
  name        text not null,
  is_default  boolean not null default false,
  unique (repo_id, name)
);

-- ---------------------------------------------------------------- delivery --

create table if not exists pull_requests (
  id                    text primary key,
  org_id                text not null references organizations(id) on delete cascade,
  repo_id               text not null references repositories(id) on delete cascade,
  provider_pr_id        text not null,
  number                integer not null,
  title                 text not null default '',
  author_user_id        text references users(id) on delete set null,
  state                 text not null check (state in ('open','closed','merged')),
  is_draft              boolean not null default false,
  base_branch           text not null,
  head_branch           text not null,
  created_at            timestamptz not null,
  ready_for_review_at   timestamptz,
  first_review_at       timestamptz,
  first_approval_at     timestamptz,
  merged_at             timestamptz,
  closed_at             timestamptz,
  reopened_count        integer not null default 0,
  additions             integer not null default 0,
  deletions             integer not null default 0,
  changed_files         integer not null default 0,
  commit_count          integer not null default 0,
  merge_commit_sha      text,
  updated_at            timestamptz not null default now(),
  unique (repo_id, number)
);

create table if not exists commits (
  id                 text primary key,
  org_id             text not null references organizations(id) on delete cascade,
  repo_id            text not null references repositories(id) on delete cascade,
  sha                text not null,
  author_user_id     text references users(id) on delete set null,
  authored_at        timestamptz not null,
  committed_at       timestamptz not null,
  message            text not null default '',
  additions          integer,
  deletions          integer,
  branch             text,
  pull_request_id    text references pull_requests(id) on delete set null,
  unique (repo_id, sha)
);

create table if not exists reviews (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  repo_id           text not null references repositories(id) on delete cascade,
  pull_request_id   text not null references pull_requests(id) on delete cascade,
  reviewer_user_id  text references users(id) on delete set null,
  state             text not null check (state in ('approved','changes_requested','commented','dismissed')),
  submitted_at      timestamptz not null,
  requested_at      timestamptz
);

create table if not exists review_comments (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  pull_request_id   text not null references pull_requests(id) on delete cascade,
  review_id         text references reviews(id) on delete set null,
  author_user_id    text references users(id) on delete set null,
  created_at        timestamptz not null,
  path              text,
  body              text not null default ''
);

-- ---------------------------------------------------------------------- CI --

create table if not exists workflows (
  id                     text primary key,
  org_id                 text not null references organizations(id) on delete cascade,
  repo_id                text not null references repositories(id) on delete cascade,
  provider               text not null,
  provider_workflow_id   text not null,
  name                   text not null,
  path                   text,
  unique (repo_id, provider, provider_workflow_id)
);

create table if not exists workflow_runs (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  repo_id           text not null references repositories(id) on delete cascade,
  workflow_id       text not null references workflows(id) on delete cascade,
  provider_run_id   text not null,
  run_attempt       integer not null default 1,
  head_sha          text not null,
  head_branch       text,
  pull_request_id   text references pull_requests(id) on delete set null,
  event             text not null default '',
  status            text not null check (status in ('queued','in_progress','completed')),
  conclusion        text check (conclusion in ('success','failure','cancelled','timed_out','skipped','neutral','action_required')),
  created_at        timestamptz not null,
  started_at        timestamptz,
  completed_at      timestamptz,
  unique (repo_id, provider_run_id, run_attempt)
);

create table if not exists deployments (
  id                       text primary key,
  org_id                   text not null references organizations(id) on delete cascade,
  repo_id                  text not null references repositories(id) on delete cascade,
  provider_deployment_id   text not null,
  environment              text not null,
  is_production            boolean not null default false,
  sha                      text not null,
  pull_request_id          text references pull_requests(id) on delete set null,
  state                    text not null check (state in ('pending','in_progress','success','failure','error','inactive')),
  created_at               timestamptz not null,
  completed_at             timestamptz,
  unique (repo_id, provider_deployment_id)
);

-- ---------------------------------------------------------------- pipeline --

-- Raw deliveries, kept for signature auditing and replay. Bodies are pruned by
-- the retention job; the hash outlives the body.
create table if not exists webhook_deliveries (
  id                 text primary key,
  org_id             text references organizations(id) on delete cascade,
  provider           text not null,
  delivery_id        text,
  event_header       text,
  signature_valid    boolean not null,
  body_sha256        text not null,
  body               text,
  received_at        timestamptz not null default now(),
  http_status        integer not null
);

-- Canonical events. `idempotency_key` is the deduplication boundary for the
-- whole system: webhooks, retries and backfill all collide here by design.
create table if not exists events (
  id                text primary key,
  org_id            text not null references organizations(id) on delete cascade,
  repo_id           text references repositories(id) on delete cascade,
  provider          text not null,
  type              text not null,
  idempotency_key   text not null unique,
  delivery_id       text,
  occurred_at       timestamptz not null,
  received_at       timestamptz not null,
  actor_user_id     text references users(id) on delete set null,
  payload           jsonb not null default '{}'::jsonb,
  processed_at      timestamptz,
  process_error     text
);

-- Durable queue. Used directly in single-node deployments and as the
-- persistence layer behind the Redis adapter, so an event is never lost
-- because a queue process died.
create table if not exists job_queue (
  id             bigserial primary key,
  org_id         text references organizations(id) on delete cascade,
  queue          text not null,
  payload        jsonb not null,
  available_at   timestamptz not null default now(),
  locked_at      timestamptz,
  locked_by      text,
  attempts       integer not null default 0,
  max_attempts   integer not null default 5,
  last_error     text,
  created_at     timestamptz not null default now(),
  completed_at   timestamptz
);

-- --------------------------------------------------------------- analytics --

create table if not exists metric_snapshots (
  id            text primary key,
  org_id        text not null references organizations(id) on delete cascade,
  metric        text not null,
  scope_type    text not null check (scope_type in ('org','repository','team','branch','developer')),
  scope_id      text not null,
  granularity   text not null check (granularity in ('day','week','month')),
  bucket_start  timestamptz not null,
  value         double precision,
  sample_size   integer not null default 0,
  -- Sufficient statistics: they let a week be rebuilt from its days without
  -- touching raw rows, which is what makes incremental recompute cheap.
  numerator     double precision,
  denominator   double precision,
  computed_at   timestamptz not null default now(),
  unique (org_id, metric, scope_type, scope_id, granularity, bucket_start)
);

create table if not exists anomalies (
  id                    text primary key,
  org_id                text not null references organizations(id) on delete cascade,
  metric                text not null,
  scope_type            text not null,
  scope_id              text not null,
  detected_at           timestamptz not null default now(),
  window_start          timestamptz not null,
  window_end            timestamptz not null,
  observed_value        double precision not null,
  baseline_value        double precision not null,
  score                 double precision not null,
  direction             text not null check (direction in ('increase','decrease')),
  severity              text not null check (severity in ('low','medium','high')),
  confidence            text not null check (confidence in ('low','medium','high')),
  sample_size           integer not null,
  baseline_sample_size  integer not null,
  status                text not null default 'open' check (status in ('open','acknowledged','resolved')),
  unique (org_id, metric, scope_type, scope_id, window_start, window_end)
);

create table if not exists investigations (
  id              text primary key,
  org_id          text not null references organizations(id) on delete cascade,
  anomaly_id      text references anomalies(id) on delete set null,
  metric          text not null,
  scope_type      text not null,
  scope_id        text not null,
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  baseline_start  timestamptz not null,
  baseline_end    timestamptz not null,
  title           text not null,
  created_at      timestamptz not null default now(),
  created_by      text references principals(id) on delete set null
);

-- One row per candidate contributor examined during an investigation, whether
-- or not it turned out to matter. Storing the negatives is what keeps the
-- narrative honest.
create table if not exists investigation_findings (
  id                 text primary key,
  org_id             text not null references organizations(id) on delete cascade,
  investigation_id   text not null references investigations(id) on delete cascade,
  dimension          text not null,
  dimension_value    text not null,
  label              text not null,
  current_value      double precision,
  baseline_value     double precision,
  contribution       double precision,
  contribution_share double precision,
  sample_size        integer not null default 0,
  baseline_sample_size integer not null default 0,
  evidence           jsonb not null default '{}'::jsonb,
  rank               integer not null default 0
);

create table if not exists audit_log (
  id              text primary key,
  org_id          text references organizations(id) on delete cascade,
  actor_user_id   text,
  action          text not null,
  resource_type   text not null,
  resource_id     text,
  detail          jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

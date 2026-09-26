-- Row-level security: tenant isolation enforced by Postgres.
--
-- `devanalytics_app`  - read/write, used by the API and worker.
-- `devanalytics_ro`   - SELECT only, used by the AI analytics path so that an
--                       LLM-planned query is incapable of mutating anything
--                       even if every application-level check were bypassed.
--
-- Both roles are subject to the same org policy. Migrations run as the owner.

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'devanalytics_app') then
    create role devanalytics_app nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'devanalytics_ro') then
    create role devanalytics_ro nologin;
  end if;
end $$;

create or replace function devanalytics_current_org() returns text
language sql stable as $$
  select nullif(current_setting('devanalytics.org_id', true), '')
$$;

do $$
declare
  t text;
  tenant_tables text[] := array[
    'teams','users','team_members','repositories','repo_connections','branches',
    'pull_requests','commits','reviews','review_comments','workflows',
    'workflow_runs','deployments','events','metric_snapshots','anomalies',
    'investigations','investigation_findings','audit_log','api_tokens','org_members'
  ];
begin
  foreach t in array tenant_tables loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists org_isolation on %I', t);
    execute format(
      'create policy org_isolation on %I using (org_id = devanalytics_current_org()) with check (org_id = devanalytics_current_org())', t);
    execute format('grant select, insert, update, delete on %I to devanalytics_app', t);
    execute format('grant select on %I to devanalytics_ro', t);
  end loop;

  -- organizations is keyed on id rather than org_id.
  execute 'alter table organizations enable row level security';
  execute 'drop policy if exists org_isolation on organizations';
  execute 'create policy org_isolation on organizations using (id = devanalytics_current_org()) with check (id = devanalytics_current_org())';
  execute 'grant select, insert, update, delete on organizations to devanalytics_app';
  execute 'grant select on organizations to devanalytics_ro';
end $$;

-- Infrastructure tables are not tenant-scoped by row; the app role may use
-- them, the read-only analytics role may not see them at all.
grant select, insert, update, delete on job_queue, webhook_deliveries, principals to devanalytics_app;
grant usage, select on sequence job_queue_id_seq to devanalytics_app;
grant execute on function devanalytics_current_org() to devanalytics_app, devanalytics_ro;

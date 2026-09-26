-- Webhook endpoints.
--
-- The signature must be verified before the body is parsed, so the secret has
-- to be selectable from the URL alone. Each endpoint gets an unguessable id
-- that appears in the webhook URL, and the secret is stored encrypted.
create table if not exists webhook_endpoints (
  id            text primary key,
  org_id        text not null references organizations(id) on delete cascade,
  provider      text not null,
  secret_enc    text not null,
  description   text not null default '',
  created_at    timestamptz not null default now(),
  revoked_at    timestamptz,
  last_seen_at  timestamptz
);

create index if not exists webhook_endpoint_org_idx on webhook_endpoints (org_id, provider);

do $$ begin
  execute 'alter table webhook_endpoints enable row level security';
  execute 'drop policy if exists org_isolation on webhook_endpoints';
  execute 'create policy org_isolation on webhook_endpoints using (org_id = devanalytics_current_org()) with check (org_id = devanalytics_current_org())';
  execute 'grant select, insert, update, delete on webhook_endpoints to devanalytics_app';
end $$;

-- Deliberately NOT granted to devanalytics_ro: the AI analytics path must not
-- be able to read encrypted secrets, even as ciphertext.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { provisionOrganization, type Database } from '@devanalytics/db';
import { runGuardedQuery, validateSelect } from '@devanalytics/ai';
import { loadFixture } from '@devanalytics/demo-data';
import { testDatabase } from '../helpers/db.js';

describe('SQL guard: static validation', () => {
  const rejected = [
    ['a write', `delete from pull_requests`],
    ['a write hidden after a select', `select 1; delete from pull_requests`],
    ['a stacked statement with a comment', `select 1 --\n; drop table events`],
    ['DDL', `drop table pull_requests`],
    ['an update', `update pull_requests set title = 'x'`],
    ['SELECT INTO', `select * into evil from pull_requests`],
    ['a locking clause', `select * from pull_requests for update`],
    ['catalog introspection', `select * from information_schema.tables`],
    ['pg_catalog access', `select * from pg_catalog.pg_class`],
    ['role enumeration', `select * from pg_roles`],
    ['file reading', `select pg_read_file('/etc/passwd')`],
    ['a sleep', `select pg_sleep(30)`],
    ['tampering with the org setting', `select set_config('devanalytics.org_id', 'other', false)`],
    ['reading the org setting', `select current_setting('devanalytics.org_id')`],
    ['API tokens', `select * from api_tokens`],
    ['webhook secrets', `select * from webhook_endpoints`],
    ['connection secrets', `select * from repo_connections`],
    ['the audit log', `select * from audit_log`],
    ['an unknown table', `select * from some_other_table`],
    ['a non-select', `with x as (select 1) insert into events select * from x`],
  ] as const;

  for (const [label, sql] of rejected) {
    it(`rejects ${label}`, () => {
      const v = validateSelect(sql);
      expect(v.safe, `${sql} was accepted`).toBe(false);
      expect(v.problems.length).toBeGreaterThan(0);
    });
  }

  const accepted = [
    `select count(*) from pull_requests`,
    `select p.number, p.title from pull_requests p join repositories r on r.id = p.repo_id where p.state = 'merged' limit 10`,
    `with merged as (select * from pull_requests where merged_at is not null) select count(*) from merged`,
    `select r.full_name, avg(extract(epoch from (p.merged_at - p.ready_for_review_at))/3600) from pull_requests p join repositories r on r.id = p.repo_id group by 1`,
  ];

  for (const sql of accepted) {
    it(`accepts a legitimate read: ${sql.slice(0, 48)}...`, () => {
      const v = validateSelect(sql);
      expect(v.problems).toEqual([]);
      expect(v.safe).toBe(true);
    });
  }

  it('cannot be evaded by hiding a keyword inside a string literal', () => {
    // The literal is stripped, so the query is a plain, safe SELECT.
    const v = validateSelect(`select 'delete from pull_requests' as note from pull_requests`);
    expect(v.safe).toBe(true);
  });

  it('still catches a keyword outside a literal on the same line', () => {
    const v = validateSelect(`select 'ok' from pull_requests where title = 'x' ; delete from events`);
    expect(v.safe).toBe(false);
  });
});

describe('SQL guard: execution', () => {
  let db: Database;
  let orgId: string;
  let otherOrgId: string;

  beforeAll(async () => {
    db = await testDatabase();
    const fixture = await loadFixture(db);
    orgId = fixture.orgId;
    const other = await provisionOrganization(db, { slug: 'other-co', name: 'Other Co' });
    otherOrgId = other.id;
    await db.withOrg(otherOrgId, (sql) =>
      sql.query(
        `insert into repositories (id, org_id, provider, provider_repo_id, name, full_name, default_branch, is_private)
         values ('secret-repo', $1, 'github', '999', 'secret', 'other-co/secret', 'main', true)`,
        [otherOrgId],
      ),
    );
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it('runs a legitimate read and returns rows', async () => {
    const result = await runGuardedQuery(db, orgId, `select number, title from pull_requests order by number`);
    expect(result.rowCount).toBeGreaterThan(0);
    expect(result.rows[0]).toHaveProperty('number');
  });

  it('refuses a write even before touching the database', async () => {
    await expect(runGuardedQuery(db, orgId, `delete from pull_requests`)).rejects.toThrow(/rejected by the SQL guard/);
  });

  it('cannot see another organization even with no org predicate', async () => {
    const result = await runGuardedQuery(db, orgId, `select full_name from repositories`);
    const names = result.rows.map((r) => r.full_name);
    expect(names).not.toContain('other-co/secret');
    expect(names).toContain('fixture-co/app');
  });

  it('cannot see another organization when it explicitly asks for one', async () => {
    const result = await runGuardedQuery(db, orgId, `select full_name from repositories where org_id <> '${orgId}'`);
    expect(result.rows).toEqual([]);
  });

  it('caps the number of rows returned regardless of the caller LIMIT', async () => {
    const result = await runGuardedQuery(db, orgId, `select number from pull_requests limit 1000`, { maxRows: 3 });
    expect(result.rowCount).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it('writes every attempt to the audit log, accepted or rejected', async () => {
    await runGuardedQuery(db, orgId, `select 1 as ok from pull_requests limit 1`, { actorUserId: 'analyst-1' });
    await runGuardedQuery(db, orgId, `drop table events`, { actorUserId: 'analyst-1' }).catch(() => undefined);

    const rows = await db.unscoped((sql) =>
      sql.query<{ action: string; actor_user_id: string | null }>(
        `select action, actor_user_id from audit_log where action like 'ai.sql.%' order by created_at`,
      ),
    );
    const actions = rows.rows.map((r) => r.action);
    expect(actions).toContain('ai.sql.executed');
    expect(actions).toContain('ai.sql.rejected');
    expect(rows.rows.every((r) => r.actor_user_id === 'analyst-1' || r.actor_user_id === null)).toBe(true);
  });

  it('leaves the read-only role unable to write even if validation were bypassed', async () => {
    // Bypassing the guard entirely: the database itself still refuses.
    await expect(
      db.withOrg(orgId, (sql) => sql.query(`delete from pull_requests`), 'readonly'),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('read-only role reach', () => {
  let db: Database;
  let orgId: string;

  beforeAll(async () => {
    db = await testDatabase();
    const fixture = await loadFixture(db);
    orgId = fixture.orgId;
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const denied = ['webhook_endpoints', 'api_tokens', 'org_members', 'webhook_deliveries', 'job_queue', 'principals'];
  for (const table of denied) {
    it(`denies the read-only role access to ${table}`, async () => {
      await expect(
        db.withOrg(orgId, (sql) => sql.many(`select * from ${table} limit 1`), 'readonly'),
      ).rejects.toThrow(/permission denied/i);
    });
  }

  const allowed = ['pull_requests', 'reviews', 'workflow_runs', 'deployments', 'metric_snapshots', 'anomalies'];
  for (const table of allowed) {
    it(`allows the read-only role to read ${table}`, async () => {
      await expect(db.withOrg(orgId, (sql) => sql.many(`select * from ${table} limit 1`), 'readonly')).resolves.toBeDefined();
    });
  }

  it('lets the application role reach credential tables it owns', async () => {
    await expect(db.withOrg(orgId, (sql) => sql.many(`select id from api_tokens limit 1`))).resolves.toBeDefined();
    await expect(db.withOrg(orgId, (sql) => sql.many(`select id from webhook_endpoints limit 1`))).resolves.toBeDefined();
  });
});

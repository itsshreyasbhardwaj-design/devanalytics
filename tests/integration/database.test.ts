import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database, provisionOrganization, upsertRepository } from '@devanalytics/db';
import { testDatabase } from '../helpers/db.js';

describe('database migrations and tenant isolation', () => {
  let db: Database;

  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db.close();
  });

  it('applies all migrations exactly once', async () => {
    const second = await db.migrate();
    expect(second).toEqual([]);
    const rows = await db.unscoped((sql) => sql.query<{ version: string }>('select version from schema_migrations order by version'));
    expect(rows.rows.map((r) => r.version)).toEqual(['0001_init', '0002_indexes', '0003_rls']);
  });

  it('creates the two least-privilege roles', async () => {
    const roles = await db.unscoped((sql) =>
      sql.query<{ rolname: string }>(`select rolname from pg_roles where rolname like 'devanalytics%' order by rolname`),
    );
    expect(roles.rows.map((r) => r.rolname)).toEqual(['devanalytics_app', 'devanalytics_ro']);
  });

  it('isolates organizations at the database level', async () => {
    const a = await db.unscoped(async (sql) => {
      await sql.query(`select set_config('devanalytics.org_id', $1, false)`, ['']);
      return null;
    });
    expect(a).toBeNull();

    const orgA = await db.withOrg('seed', async () => null, 'owner');
    expect(orgA).toBeNull();

    // Create two orgs as owner (bypasses RLS, as migrations/bootstrap do).
    const ids = await db.unscoped(async (sql) => {
      await sql.query(`insert into organizations (id, slug, name) values ('o1','acme','Acme'), ('o2','globex','Globex')`);
      await sql.query(
        `insert into repositories (id, org_id, provider, provider_repo_id, name, full_name, default_branch, is_private)
         values ('r1','o1','github','1','a','acme/a','main',true),
                ('r2','o2','github','2','b','globex/b','main',true)`,
      );
      return ['o1', 'o2'];
    });
    expect(ids).toEqual(['o1', 'o2']);

    const seenByO1 = await db.withOrg('o1', (sql) => sql.many<{ id: string }>(`select id from repositories`));
    expect(seenByO1.map((r) => r.id)).toEqual(['r1']);

    const seenByO2 = await db.withOrg('o2', (sql) => sql.many<{ id: string }>(`select id from repositories`));
    expect(seenByO2.map((r) => r.id)).toEqual(['r2']);

    // Even an explicitly cross-tenant query returns nothing.
    const crossTenant = await db.withOrg('o1', (sql) =>
      sql.many<{ id: string }>(`select id from repositories where org_id = 'o2'`),
    );
    expect(crossTenant).toEqual([]);
  });

  it('refuses writes that would land in another tenant', async () => {
    await expect(
      db.withOrg('o1', (sql) =>
        sql.query(
          `insert into repositories (id, org_id, provider, provider_repo_id, name, full_name, default_branch, is_private)
           values ('r3','o2','github','3','c','globex/c','main',true)`,
        ),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('gives the read-only role no write path', async () => {
    await expect(
      db.withOrg('o1', (sql) => sql.query(`delete from repositories where id = 'r1'`), 'readonly'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('round-trips org-scoped upserts', async () => {
    const created = await provisionOrganization(db, { slug: 'initech', name: 'Initech' });
    const org = created.id;
    const repo = await db.withOrg(org, async (sql) => {
      return upsertRepository(sql, {
        provider: 'github', providerRepoId: '900', name: 'api', fullName: 'initech/api',
        defaultBranch: 'main', isPrivate: true,
      });
    });
    expect(repo.fullName).toBe('initech/api');
    const again = await db.withOrg(org, (sql) =>
      upsertRepository(sql, {
        provider: 'github', providerRepoId: '900', name: 'api', fullName: 'initech/api',
        defaultBranch: 'main', isPrivate: false,
      }),
    );
    expect(again.id).toBe(repo.id);
  });
});

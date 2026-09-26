import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Database } from '@devanalytics/db';
import { testDatabase } from '../helpers/db.js';

/**
 * The embedded driver holds a single Postgres connection, so concurrency is
 * the driver's responsibility. These are regression tests for interleaving:
 * overlapping transactions on one connection silently corrupt each other's
 * session state, and a query racing a close faults the WASM heap.
 */
describe('embedded driver concurrency', () => {
  let db: Database;

  beforeAll(async () => {
    db = await testDatabase();
    await db.unscoped((sql) =>
      sql.query(`insert into organizations (id, slug, name) values ('c1','c1','C1'), ('c2','c2','C2')`),
    );
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  it('keeps concurrent org-scoped transactions from leaking into each other', async () => {
    await db.unscoped((sql) =>
      sql.query(
        `insert into repositories (id, org_id, provider, provider_repo_id, name, full_name, default_branch, is_private)
         values ('c1r','c1','github','1','a','c1/a','main',true), ('c2r','c2','github','2','b','c2/b','main',true)`,
      ),
    );

    // Fire 40 interleaved transactions across two tenants at once.
    const work = Array.from({ length: 40 }, (_, i) => {
      const org = i % 2 === 0 ? 'c1' : 'c2';
      return db.withOrg(org, async (sql) => {
        const rows = await sql.many<{ id: string }>(`select id from repositories`);
        return { org, ids: rows.map((r) => r.id) };
      });
    });

    const results = await Promise.all(work);
    for (const r of results) {
      expect(r.ids, `${r.org} saw the wrong rows`).toEqual([r.org === 'c1' ? 'c1r' : 'c2r']);
    }
  });

  it('rolls back a failed transaction without breaking the next one', async () => {
    await expect(
      db.withOrg('c1', async (sql) => {
        await sql.query(`insert into teams (id, org_id, slug, name) values ('t-ok','c1','ok','OK')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const teams = await db.withOrg('c1', (sql) => sql.many<{ id: string }>(`select id from teams`));
    expect(teams).toEqual([]);

    const after = await db.withOrg('c1', async (sql) => {
      await sql.query(`insert into teams (id, org_id, slug, name) values ('t2','c1','two','Two')`);
      return sql.many<{ id: string }>(`select id from teams`);
    });
    expect(after.map((t) => t.id)).toEqual(['t2']);
  });

  it('drains outstanding work before closing rather than faulting', async () => {
    const scratch = await Database.pglite();
    await scratch.migrate();
    await scratch.unscoped((sql) => sql.query(`insert into organizations (id, slug, name) values ('x','x','X')`));

    const pending = Array.from({ length: 25 }, () =>
      scratch.withOrg('x', (sql) => sql.value<number>(`select count(*)::int from organizations`)),
    );
    // Close while work is still queued.
    const closing = scratch.close();
    const [counts] = await Promise.all([Promise.all(pending), closing]);
    expect(counts.every((c) => c === 1)).toBe(true);
    await expect(scratch.withOrg('x', (sql) => sql.many(`select 1`))).rejects.toThrow(/closed/);
  });
});

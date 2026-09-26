import type { SqlDriver, SqlParam, QueryResult } from './driver.js';
import { MIGRATIONS } from './migrations.generated.js';
import { PGliteDriver } from './pglite-driver.js';
import { PostgresDriver } from './postgres-driver.js';

export type DbRole = 'app' | 'readonly' | 'owner';

const ROLE_NAME: Record<Exclude<DbRole, 'owner'>, string> = {
  app: 'devanalytics_app',
  readonly: 'devanalytics_ro',
};

/**
 * Org-scoped database handle.
 *
 * Nothing in the application talks to a `SqlDriver` directly. All tenant data
 * is reached through `Database.withOrg(orgId, ...)`, which
 *   1. opens a transaction,
 *   2. assumes the least-privileged role for the work, and
 *   3. sets `devanalytics.org_id` for the duration of that transaction.
 *
 * The row-level security policies in migration 0003 then make it impossible
 * for a query inside the callback to observe or modify another tenant's rows,
 * even if the query itself forgets an `org_id` predicate.
 */
export class Database {
  constructor(private readonly driver: SqlDriver) {}

  static async pglite(dataDir?: string): Promise<Database> {
    return new Database(await PGliteDriver.create(dataDir));
  }

  static async postgres(connectionString: string): Promise<Database> {
    return new Database(await PostgresDriver.create({ connectionString }));
  }

  get raw(): SqlDriver {
    return this.driver;
  }

  /** Runs migrations as the owner role. Idempotent. */
  async migrate(): Promise<string[]> {
    const applied: string[] = [];
    await this.driver.exec(
      `create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`,
    );
    const done = new Set(
      (await this.driver.query<{ version: string }>(`select version from schema_migrations`)).rows.map((r) => r.version),
    );
    for (const m of MIGRATIONS) {
      if (done.has(m.version)) continue;
      await this.driver.exec(m.sql);
      await this.driver.query(`insert into schema_migrations (version) values ($1) on conflict do nothing`, [m.version]);
      applied.push(m.version);
    }
    return applied;
  }

  /**
   * Execute `fn` scoped to one organization under the given role.
   * `role: 'readonly'` is used by the AI analytics path.
   */
  async withOrg<T>(orgId: string, fn: (sql: ScopedSql) => Promise<T>, role: DbRole = 'app'): Promise<T> {
    return this.driver.transaction(async (tx) => {
      if (role !== 'owner') {
        await tx.query(`set local role ${ROLE_NAME[role]}`);
      }
      await tx.query(`select set_config('devanalytics.org_id', $1, true)`, [orgId]);
      return fn(new ScopedSql(tx, orgId, role));
    });
  }

  /**
   * Escape hatch for work that is genuinely not tenant-scoped: migrations,
   * queue polling, principal lookup during authentication, retention jobs.
   * Deliberately verbose so it is easy to audit every call site.
   */
  async unscoped<T>(fn: (sql: SqlDriver) => Promise<T>): Promise<T> {
    return this.driver.transaction(fn);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

/** A driver bound to one organization and one role. */
export class ScopedSql {
  constructor(
    private readonly tx: SqlDriver,
    readonly orgId: string,
    readonly role: DbRole,
  ) {}

  query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    return this.tx.query<T>(text, params);
  }

  async one<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<T | null> {
    const r = await this.tx.query<T>(text, params);
    return r.rows[0] ?? null;
  }

  async many<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<T[]> {
    return (await this.tx.query<T>(text, params)).rows;
  }

  async value<T = number>(text: string, params: SqlParam[] = []): Promise<T | null> {
    const row = await this.one<Record<string, T>>(text, params);
    if (!row) return null;
    const first = Object.values(row)[0];
    return (first ?? null) as T | null;
  }
}

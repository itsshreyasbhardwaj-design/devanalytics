import type { SqlDriver, QueryResult, SqlParam } from './driver.js';
import { SqlError } from './driver.js';

interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}
interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(): void;
}

/**
 * node-postgres driver for managed Postgres (including Supabase).
 *
 * `pg` is imported lazily so that environments which only ever use PGlite —
 * CI, local dev, the test suite — never pull in native-ish deps.
 */
export class PostgresDriver implements SqlDriver {
  readonly dialect = 'postgres' as const;

  private constructor(private readonly pool: PgPoolLike) {}

  static async create(opts: {
    connectionString: string;
    max?: number;
    statementTimeoutMs?: number;
    applicationName?: string;
  }): Promise<PostgresDriver> {
    const mod = (await import('pg' as string)) as unknown as { default?: { Pool: new (c: unknown) => PgPoolLike }; Pool?: new (c: unknown) => PgPoolLike };
    const Pool = mod.Pool ?? mod.default?.Pool;
    if (!Pool) throw new Error('pg.Pool unavailable');
    const pool = new Pool({
      connectionString: opts.connectionString,
      max: opts.max ?? 10,
      application_name: opts.applicationName ?? 'devanalytics',
      statement_timeout: opts.statementTimeoutMs ?? 15_000,
    });
    return new PostgresDriver(pool);
  }

  async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    try {
      const res = await this.pool.query(text, params as unknown[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    } catch (err) {
      throw new SqlError(`query failed: ${(err as Error).message}`, text, err);
    }
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.pool.query(sql);
    } catch (err) {
      throw new SqlError(`exec failed: ${(err as Error).message}`, sql, err);
    }
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const scoped: SqlDriver = {
      dialect: 'postgres',
      query: async <T2 = Record<string, unknown>>(text: string, params: SqlParam[] = []) => {
        const res = await client.query(text, params as unknown[]);
        return { rows: res.rows as T2[], rowCount: res.rowCount ?? res.rows.length };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
      transaction: async <T3>(f: (tx: SqlDriver) => Promise<T3>) => f(scoped),
      close: async () => undefined,
    };
    try {
      await client.query('begin');
      const out = await fn(scoped);
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

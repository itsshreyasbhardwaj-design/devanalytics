import { PGlite } from '@electric-sql/pglite';
import type { SqlDriver, QueryResult, SqlParam } from './driver.js';
import { SqlError } from './driver.js';

/**
 * PGlite driver.
 *
 * PGlite is single-connection, so `transaction` serialises through a promise
 * chain rather than checking out a pooled connection. That is also why the
 * session-level org setting used by RLS is safe here: there is exactly one
 * session, and the org is set at the start of every scoped unit of work.
 */
export class PGliteDriver implements SqlDriver {
  readonly dialect = 'pglite' as const;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(private readonly pg: PGlite) {}

  static async create(dataDir?: string): Promise<PGliteDriver> {
    const pg = dataDir ? new PGlite(dataDir) : new PGlite();
    await pg.waitReady;
    return new PGliteDriver(pg);
  }

  async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    try {
      const res = await this.pg.query<T>(text, params as unknown[]);
      return { rows: res.rows, rowCount: res.rows.length };
    } catch (err) {
      throw new SqlError(`query failed: ${(err as Error).message}`, text, err);
    }
  }

  async exec(sql: string): Promise<void> {
    try {
      await this.pg.exec(sql);
    } catch (err) {
      throw new SqlError(`exec failed: ${(err as Error).message}`, sql, err);
    }
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      await this.pg.exec('begin');
      try {
        const result = await fn(this);
        await this.pg.exec('commit');
        return result;
      } catch (err) {
        await this.pg.exec('rollback').catch(() => undefined);
        throw err;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

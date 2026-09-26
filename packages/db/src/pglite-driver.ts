import type { PGlite } from '@electric-sql/pglite';
import type { SqlDriver, QueryResult, SqlParam } from './driver.js';
import { SqlError } from './driver.js';

/**
 * PGlite driver.
 *
 * PGlite is a single Postgres connection compiled to WebAssembly. That makes
 * concurrency the driver's problem rather than the pool's: two overlapping
 * `begin`/`commit` sequences on one connection interleave into nonsense, and
 * a query issued while another is mid-flight can fault the WASM heap.
 *
 * So every operation — standalone queries, multi-statement execs and whole
 * transactions — is serialised through one mutex. A transaction holds the
 * mutex for its entire body, which is what makes `withOrg`'s `set local role`
 * and org setting reliable: nothing else can run between them.
 */
export class PGliteDriver implements SqlDriver {
  readonly dialect = 'pglite' as const;
  /** Tail of the work queue. Never rejects, so one failure cannot poison the queue. */
  private tail: Promise<void> = Promise.resolve();
  private inTransaction = false;
  private closed = false;

  private constructor(private readonly pg: PGlite) {}

  /**
   * Loaded at call time rather than imported at module scope.
   *
   * PGlite ships a WebAssembly build that locates its own artefacts through
   * `new URL(..., import.meta.url)`. A bundler that inlines the package
   * rewrites those URLs and the runtime then hands Node's fs a value it
   * rejects. Resolving the specifier at runtime keeps the package external
   * under every bundler, and means deployments that only use managed Postgres
   * never load it at all.
   */
  static async create(dataDir?: string): Promise<PGliteDriver> {
    const specifier = ['@electric-sql', 'pglite'].join('/');
    const mod = (await import(/* webpackIgnore: true */ specifier)) as { PGlite: new (dir?: string) => PGlite };
    const pg = dataDir ? new mod.PGlite(dataDir) : new mod.PGlite();
    await pg.waitReady;
    return new PGliteDriver(pg);
  }

  /** Run `fn` with exclusive access to the connection. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed) throw new SqlError('database is closed', '');
  }

  async query<T = Record<string, unknown>>(text: string, params: SqlParam[] = []): Promise<QueryResult<T>> {
    // A query issued from inside a transaction body already holds the mutex;
    // re-acquiring it would deadlock against the transaction that owns it.
    return this.inTransaction ? this.rawQuery<T>(text, params) : this.serialize(() => this.rawQuery<T>(text, params));
  }

  private async rawQuery<T>(text: string, params: SqlParam[]): Promise<QueryResult<T>> {
    this.assertOpen();
    try {
      const res = await this.pg.query<T>(text, params as unknown[]);
      return { rows: res.rows, rowCount: res.rows.length };
    } catch (err) {
      throw new SqlError(`query failed: ${(err as Error).message}`, text, err);
    }
  }

  async exec(sql: string): Promise<void> {
    const run = async () => {
      this.assertOpen();
      try {
        await this.pg.exec(sql);
      } catch (err) {
        throw new SqlError(`exec failed: ${(err as Error).message}`, sql, err);
      }
    };
    return this.inTransaction ? run() : this.serialize(run);
  }

  async transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T> {
    return this.serialize(async () => {
      this.assertOpen();
      this.inTransaction = true;
      try {
        await this.pg.exec('begin');
        try {
          const result = await fn(this);
          await this.pg.exec('commit');
          return result;
        } catch (err) {
          await this.pg.exec('rollback').catch(() => undefined);
          throw err;
        }
      } finally {
        this.inTransaction = false;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Drain outstanding work before freeing the WASM heap: closing underneath a
    // queued query is what produces "memory access out of bounds".
    await this.tail.catch(() => undefined);
    this.closed = true;
    await this.pg.close();
  }
}

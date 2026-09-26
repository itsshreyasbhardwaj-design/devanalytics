/**
 * Minimal SQL driver surface.
 *
 * Two implementations ship: PGlite (embedded Postgres 16 — used for tests,
 * local development and single-node deployments) and node-postgres (used for
 * managed Postgres / Supabase). Both speak the same dialect because PGlite is
 * real Postgres, so queries are not written twice and are not written to a
 * lowest common denominator.
 */

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export type SqlParam = string | number | boolean | Date | null | undefined | object;

export interface SqlDriver {
  query<T = Record<string, unknown>>(text: string, params?: SqlParam[]): Promise<QueryResult<T>>;
  /** Multi-statement execution. Never accepts user input. */
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: SqlDriver) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly dialect: 'pglite' | 'postgres';
}

export class SqlError extends Error {
  constructor(
    message: string,
    readonly sql: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SqlError';
  }
}

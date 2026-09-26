import { Database } from '@devanalytics/db';

/**
 * Every integration test gets its own embedded Postgres 16 instance.
 * No shared state, no Docker, no cleanup between tests.
 */
export async function testDatabase(): Promise<Database> {
  const db = await Database.pglite();
  await db.migrate();
  return db;
}

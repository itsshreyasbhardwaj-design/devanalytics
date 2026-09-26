/** Applies pending migrations. Idempotent. */
import { Database } from '@devanalytics/db';

const db = process.env.DATABASE_URL
  ? await Database.postgres(process.env.DATABASE_URL)
  : await Database.pglite(process.env.DEVANALYTICS_EMBEDDED_DATA_DIR ?? '.pgdata');

const applied = await db.migrate();
console.log(applied.length === 0 ? 'Already up to date.' : `Applied: ${applied.join(', ')}`);
await db.close();

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from '@devanalytics/db';

/**
 * The migration runner reads from a generated TS module so migrations work in
 * runtimes without filesystem access (bundled Next.js server code). That
 * module can drift from the .sql files it was generated from, so this test
 * fails the build when it does.
 */
describe('generated migrations module', () => {
  const dir = path.resolve('packages/db/src/migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  it('covers every .sql file, in order', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(files.map((f) => f.replace(/\.sql$/, '')));
  });

  it('matches the .sql files byte for byte', () => {
    for (const [i, file] of files.entries()) {
      expect(MIGRATIONS[i]?.sql, `${file} is stale - run pnpm db:gen`).toBe(readFileSync(path.join(dir, file), 'utf8'));
    }
  });

  it('is ordered so that later migrations can depend on earlier ones', () => {
    const versions = MIGRATIONS.map((m) => m.version);
    expect([...versions].sort()).toEqual(versions);
  });
});

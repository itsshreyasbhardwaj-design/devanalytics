/** Embeds packages/db/src/migrations/*.sql into a TS module so migrations work
 *  in any runtime (Next.js server bundles, workers, tests) without fs access. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve('packages/db/src/migrations');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
const parts = files.map((f) => {
  const sql = readFileSync(path.join(dir, f), 'utf8');
  return `  {\n    version: ${JSON.stringify(f.replace(/\.sql$/, ''))},\n    sql: ${JSON.stringify(sql)},\n  },`;
});
const out = `// GENERATED FILE - do not edit. Run \`pnpm db:gen\` after changing any .sql file.
export interface Migration { version: string; sql: string }

export const MIGRATIONS: readonly Migration[] = [
${parts.join('\n')}
];
`;
writeFileSync(path.resolve('packages/db/src/migrations.generated.ts'), out);
console.log(`generated ${files.length} migrations:`, files.join(', '));

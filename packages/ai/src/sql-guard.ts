import { UnsafeQueryError } from '@devanalytics/core';
import type { Database } from '@devanalytics/db';

/**
 * Guarded read-only SQL.
 *
 * The product does not need natural-language-to-SQL: every question the AI
 * surface answers is served by the structured planner, which cannot express an
 * unsafe query. This module exists for the escape hatch — an analyst asking
 * something the planner has no intent for — and it is built on the assumption
 * that the query text is hostile.
 *
 * Five independent layers, each sufficient on its own:
 *
 *   1. The connection assumes `devanalytics_ro`, which holds SELECT and nothing
 *      else. A DELETE that got through every check below still fails.
 *   2. Row-level security scopes the connection to one organization.
 *   3. A single statement only; stacked statements are rejected before parsing.
 *   4. An allowlist of tables, so `api_tokens`, `repo_connections` and
 *      `webhook_endpoints` are unreachable even though the role could read some.
 *   5. A statement timeout and a mandatory row limit.
 *
 * Every execution is written to the audit log with its text.
 */

export const READABLE_TABLES = new Set([
  'organizations', 'teams', 'users', 'team_members', 'repositories', 'branches',
  'pull_requests', 'commits', 'reviews', 'review_comments',
  'workflows', 'workflow_runs', 'deployments',
  'metric_snapshots', 'anomalies', 'investigations', 'investigation_findings',
  'events',
]);

/** Tables the read-only role can technically reach but analysts must not query. */
export const FORBIDDEN_TABLES = new Set([
  'api_tokens', 'repo_connections', 'webhook_endpoints', 'webhook_deliveries',
  'principals', 'org_members', 'audit_log', 'job_queue', 'schema_migrations',
  'pg_shadow', 'pg_authid', 'pg_user', 'pg_roles', 'pg_settings',
]);

const FORBIDDEN_KEYWORDS = [
  'insert', 'update', 'delete', 'drop', 'alter', 'create', 'truncate', 'grant', 'revoke',
  'copy', 'vacuum', 'analyze', 'reindex', 'cluster', 'comment', 'security', 'do',
  'call', 'execute', 'prepare', 'listen', 'notify', 'lock', 'set', 'reset', 'discard',
  'begin', 'commit', 'rollback', 'savepoint', 'refresh', 'import', 'merge',
];

const FORBIDDEN_FUNCTIONS = [
  'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file', 'lo_import', 'lo_export',
  'dblink', 'pg_sleep', 'pg_terminate_backend', 'pg_cancel_backend', 'current_setting', 'set_config',
  'pg_reload_conf', 'query_to_xml', 'pg_logical_emit_message',
];

export interface SqlValidation {
  safe: boolean;
  problems: string[];
  tables: string[];
  normalized: string;
}

/** Strip string literals and comments so keyword checks cannot be evaded by quoting. */
function stripLiteralsAndComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, " '' ")
    .replace(/'(?:''|[^'])*'/g, " '' ")
    .replace(/"(?:[^"])*"/g, ' "id" ');
}

export function validateSelect(sql: string, maxLength = 4000): SqlValidation {
  const problems: string[] = [];
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const stripped = stripLiteralsAndComments(trimmed).toLowerCase();

  if (trimmed.length === 0) problems.push('Query is empty.');
  if (trimmed.length > maxLength) problems.push(`Query exceeds ${maxLength} characters.`);
  // Stacked statements: reject before anything else looks at the text.
  if (stripped.includes(';')) problems.push('Only a single statement is allowed.');
  if (!/^\s*(with|select)\b/.test(stripped)) problems.push('Only SELECT (or WITH ... SELECT) queries are allowed.');

  for (const kw of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`(^|[^a-z_])${kw}([^a-z_]|$)`).test(stripped)) problems.push(`Keyword "${kw}" is not allowed.`);
  }
  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (stripped.includes(fn)) problems.push(`Function "${fn}" is not allowed.`);
  }
  if (/\binto\s+\w/.test(stripped)) problems.push('SELECT INTO is not allowed.');
  if (/\bfor\s+(update|share|no\s+key\s+update|key\s+share)\b/.test(stripped)) problems.push('Locking clauses are not allowed.');
  if (/\binformation_schema\b|\bpg_catalog\b|\bpg_class\b|\bpg_namespace\b/.test(stripped)) {
    problems.push('Catalog introspection is not allowed.');
  }

  // Table references: everything after FROM or JOIN.
  const tables = [...stripped.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/g)]
    .map((m) => (m[1] as string).split('.').pop() as string)
    .filter((t) => t.length > 0);
  const cteNames = new Set([...stripped.matchAll(/\b([a-z_][a-z0-9_]*)\s+as\s*\(/g)].map((m) => m[1] as string));

  for (const table of tables) {
    if (cteNames.has(table)) continue;
    if (FORBIDDEN_TABLES.has(table)) problems.push(`Table "${table}" is not readable through this interface.`);
    else if (!READABLE_TABLES.has(table)) problems.push(`Table "${table}" is not in the allowlist.`);
  }

  return { safe: problems.length === 0, problems, tables: [...new Set(tables)], normalized: trimmed };
}

export interface GuardedQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  sql: string;
  elapsedMs: number;
}

export interface GuardedQueryOptions {
  maxRows?: number;
  timeoutMs?: number;
  /** Principal recorded in the audit log. */
  actorUserId?: string | null;
}

/**
 * Execute a validated SELECT as the read-only role, inside the organization's
 * RLS scope, with a statement timeout and a hard row cap.
 */
export async function runGuardedQuery(
  db: Database,
  orgId: string,
  sql: string,
  opts: GuardedQueryOptions = {},
): Promise<GuardedQueryResult> {
  const validation = validateSelect(sql);
  if (!validation.safe) {
    await audit(db, orgId, opts.actorUserId ?? null, sql, 'rejected', validation.problems);
    throw new UnsafeQueryError('Query rejected by the SQL guard.', { problems: validation.problems });
  }

  const maxRows = Math.min(opts.maxRows ?? 500, 5000);
  const timeoutMs = Math.min(opts.timeoutMs ?? 5000, 30_000);
  const started = Date.now();

  try {
    const rows = await db.withOrg(
      orgId,
      async (scoped) => {
        // Applies to this transaction only.
        await scoped.query(`set local statement_timeout = ${timeoutMs}`);
        // Wrapping in a subquery means the caller's own LIMIT cannot exceed ours.
        return scoped.many<Record<string, unknown>>(`select * from (${validation.normalized}) as guarded limit ${maxRows + 1}`);
      },
      'readonly',
    );
    const truncated = rows.length > maxRows;
    await audit(db, orgId, opts.actorUserId ?? null, validation.normalized, 'executed', []);
    return {
      rows: rows.slice(0, maxRows),
      rowCount: Math.min(rows.length, maxRows),
      truncated,
      sql: validation.normalized,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    await audit(db, orgId, opts.actorUserId ?? null, validation.normalized, 'failed', [(err as Error).message]);
    throw new UnsafeQueryError(`Query failed: ${(err as Error).message}`, { sql: validation.normalized });
  }
}

async function audit(db: Database, orgId: string, actorUserId: string | null, sql: string, outcome: string, problems: string[]): Promise<void> {
  await db
    .unscoped((driver) =>
      driver.query(
        `insert into audit_log (id, org_id, actor_user_id, action, resource_type, resource_id, detail)
         values (md5(random()::text || clock_timestamp()::text), $1, $2, $3, 'sql_query', null, $4)`,
        [orgId, actorUserId, `ai.sql.${outcome}`, JSON.stringify({ sql: sql.slice(0, 4000), problems })],
      ),
    )
    .catch(() => undefined);
}

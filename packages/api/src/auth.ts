import { UnauthorizedError, type Principal, type Role } from '@devanalytics/core';
import { hashToken, safeEqual, type Database } from '@devanalytics/db';

/**
 * Authentication.
 *
 * Two principal types, one Principal shape. Everything downstream — RBAC,
 * org scoping, audit logging — sees only the shape and cannot tell whether the
 * caller is a browser session or an API token.
 */

export interface AuthProvider {
  readonly name: string;
  /** Returns null when this provider does not apply to the request. */
  authenticate(request: Request): Promise<Principal | null>;
}

/**
 * API tokens.
 *
 * Only a SHA-256 of the token is stored. Lookup is by hash, so a database
 * disclosure does not yield usable credentials, and the comparison is
 * constant-time to keep the hash itself from being probed byte by byte.
 */
export class ApiTokenAuthProvider implements AuthProvider {
  readonly name = 'api_token';

  constructor(private readonly db: Database) {}

  async authenticate(request: Request): Promise<Principal | null> {
    const header = request.headers.get('authorization');
    if (!header?.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token.startsWith('dva_')) return null;

    const hash = hashToken(token);
    const row = await this.db.unscoped(async (sql) => {
      const res = await sql.query<{ id: string; org_id: string; principal_id: string; role: string; token_hash: string }>(
        `select id, org_id, principal_id, role, token_hash from api_tokens where token_hash = $1 and revoked_at is null`,
        [hash],
      );
      return res.rows[0] ?? null;
    });
    if (!row || !safeEqual(row.token_hash, hash)) return null;

    // Best-effort usage timestamp; never blocks the request.
    void this.db
      .unscoped((sql) => sql.query(`update api_tokens set last_used_at = now() where id = $1`, [row.id]))
      .catch(() => undefined);

    return { userId: row.principal_id, orgId: row.org_id, role: row.role as Role, tokenId: row.id };
  }
}

/**
 * Clerk sessions.
 *
 * Verification is delegated to Clerk's backend API rather than reimplemented,
 * and the org membership and role come from our own `org_members` table — a
 * claim in a third-party token never decides what a user may see here.
 */
export interface ClerkVerifier {
  verify(sessionToken: string): Promise<{ subject: string; email: string | null } | null>;
}

export class ClerkAuthProvider implements AuthProvider {
  readonly name = 'clerk';

  constructor(
    private readonly db: Database,
    private readonly verifier: ClerkVerifier,
  ) {}

  async authenticate(request: Request): Promise<Principal | null> {
    const token = sessionTokenFrom(request);
    if (!token) return null;
    const verified = await this.verifier.verify(token);
    if (!verified) return null;

    const row = await this.db.unscoped(async (sql) => {
      const res = await sql.query<{ principal_id: string; org_id: string; role: string }>(
        `select p.id as principal_id, m.org_id, m.role
           from principals p
           join org_members m on m.principal_id = p.id
          where p.auth_provider = 'clerk' and p.auth_subject = $1
          order by m.created_at
          limit 1`,
        [verified.subject],
      );
      return res.rows[0] ?? null;
    });
    if (!row) return null;
    return { userId: row.principal_id, orgId: row.org_id, role: row.role as Role, tokenId: null };
  }
}

function sessionTokenFrom(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (header?.startsWith('Bearer ') && !header.includes('dva_')) return header.slice(7).trim();
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const match = /(?:^|;\s*)__session=([^;]+)/.exec(cookie);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/**
 * Local development principal.
 *
 * Enabled only when DEVANALYTICS_AUTH_MODE is exactly "local-dev", which the
 * production entrypoint refuses to start with. It exists so the dashboard and
 * the test suite can run without a Clerk account, not as a fallback.
 */
export class LocalDevAuthProvider implements AuthProvider {
  readonly name = 'local_dev';

  constructor(
    private readonly orgId: string,
    private readonly role: Role = 'owner',
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async authenticate(_request: Request): Promise<Principal | null> {
    if (this.env.DEVANALYTICS_AUTH_MODE !== 'local-dev') return null;
    return { userId: 'local-dev-principal', orgId: this.orgId, role: this.role, tokenId: null };
  }
}

export class AuthChain {
  constructor(private readonly providers: AuthProvider[]) {}

  async authenticate(request: Request): Promise<Principal> {
    for (const provider of this.providers) {
      const principal = await provider.authenticate(request);
      if (principal) return principal;
    }
    throw new UnauthorizedError('No valid credentials. Send an API token as "Authorization: Bearer dva_...".');
  }
}

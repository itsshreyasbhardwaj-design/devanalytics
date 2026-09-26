import 'server-only';
import { headers, cookies } from 'next/headers';
import type { Principal } from '@devanalytics/core';
import { getRuntime } from './runtime.js';

/**
 * Session resolution for server components.
 *
 * Server components do not carry a Request, so the auth chain is fed the
 * incoming headers and cookies directly. In local-dev mode the organization is
 * selected from a cookie (or the first one that exists), which is why that mode
 * is refused outright when NODE_ENV is production.
 */
export interface Session {
  principal: Principal;
  orgId: string;
  orgName: string;
  orgSlug: string;
  isDemo: boolean;
  /** True when there is no organization at all yet. */
  empty: boolean;
}

export async function getSession(): Promise<Session> {
  const runtime = await getRuntime();
  const h = await headers();
  const c = await cookies();

  const request = new Request('http://internal/session', {
    headers: new Headers(Object.fromEntries(h.entries())),
  });

  let principal: Principal | null = null;
  try {
    principal = await runtime.api.router ? await resolve(request) : null;
  } catch {
    principal = null;
  }

  if (!principal) {
    const preferred = c.get('da_org')?.value;
    const org = await runtime.db.unscoped(async (sql) => {
      const res = await sql.query<{ id: string; name: string; slug: string; is_demo: boolean }>(
        preferred
          ? `select id, name, slug, is_demo from organizations where id = $1`
          : `select id, name, slug, is_demo from organizations order by created_at limit 1`,
        preferred ? [preferred] : [],
      );
      return res.rows[0] ?? null;
    });
    if (!org) {
      return {
        principal: { userId: 'anonymous', orgId: '', role: 'viewer', tokenId: null },
        orgId: '', orgName: '', orgSlug: '', isDemo: false, empty: true,
      };
    }
    return {
      principal: { userId: 'local', orgId: org.id, role: 'owner', tokenId: null },
      orgId: org.id, orgName: org.name, orgSlug: org.slug, isDemo: org.is_demo, empty: false,
    };
  }

  const org = await runtime.db.withOrg(principal.orgId, (sql) =>
    sql.one<{ name: string; slug: string; is_demo: boolean }>(`select name, slug, is_demo from organizations where id = $1`, [principal.orgId]),
    'readonly');

  return {
    principal,
    orgId: principal.orgId,
    orgName: org?.name ?? 'Organization',
    orgSlug: org?.slug ?? '',
    isDemo: org?.is_demo ?? false,
    empty: false,
  };
}

async function resolve(request: Request): Promise<Principal | null> {
  const runtime = await getRuntime();
  try {
    // Reuse the API's own auth chain so the dashboard and the API agree on
    // identity; a failure here falls back to the local-dev path above.
    const res = await runtime.api.handle(new Request('http://internal/api/v1/me', { headers: request.headers }));
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { userId: string; orgId: string; role: Principal['role']; viaToken: boolean } };
    if (!body.data) return null;
    return { userId: body.data.userId, orgId: body.data.orgId, role: body.data.role, tokenId: body.data.viaToken ? 'token' : null };
  } catch {
    return null;
  }
}

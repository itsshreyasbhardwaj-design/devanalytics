import { DevAnalyticsError, ValidationError, type Principal } from '@devanalytics/core';

/**
 * Tiny router over the Web Fetch API.
 *
 * Handlers are plain (Request) => Response functions, so the exact same route
 * table is mounted by the Next.js app and by the standalone Node API server.
 * There is one implementation of every endpoint.
 */

export interface RouteContext {
  principal: Principal;
  params: Record<string, string>;
  url: URL;
  request: Request;
}

export type RouteHandler = (ctx: RouteContext) => Promise<unknown>;

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Pattern with :params, e.g. /api/v1/metrics/:metric/value */
  pattern: string;
  handler: RouteHandler;
  /** Rate-limit policy name. */
  policy?: string;
  /** When true, the route runs before authentication (webhooks, health). */
  public?: boolean;
  summary: string;
}

interface Compiled extends Route {
  segments: string[];
}

export class Router {
  private readonly routes: Compiled[] = [];

  add(route: Route): this {
    this.routes.push({ ...route, segments: route.pattern.split('/').filter(Boolean) });
    return this;
  }

  match(method: string, pathname: string): { route: Compiled; params: Record<string, string> } | null {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (const [i, seg] of route.segments.entries()) {
        const actual = parts[i] as string;
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual);
        else if (seg !== actual) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }

  list(): Route[] {
    return this.routes.map(({ segments: _s, ...r }) => r);
  }
}

export interface ApiResponse<T = unknown> {
  data: T;
  meta?: Record<string, unknown>;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof DevAnalyticsError) {
    return json(
      { error: { code: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) } },
      err.httpStatus,
      err.code === 'rate_limited' ? { 'retry-after': String((err.detail as { retryAfterSeconds: number }).retryAfterSeconds) } : {},
    );
  }
  // Internal failures never leak a stack trace or SQL text to the caller.
  const message = err instanceof Error ? err.message : 'Unexpected error';
  return json({ error: { code: 'internal_error', message: 'Request failed', detail: { hint: message.slice(0, 200) } } }, 500);
}

export function requireParam(ctx: RouteContext, name: string): string {
  const value = ctx.params[name];
  if (!value) throw new ValidationError(`Missing path parameter "${name}"`);
  return value;
}

export function requireQuery(ctx: RouteContext, name: string): string {
  const value = ctx.url.searchParams.get(name);
  if (!value) throw new ValidationError(`Missing required query parameter "${name}"`);
  return value;
}

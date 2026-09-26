import {
  METRIC_IDS,
  MetricEngine,
  METRIC_DEFINITIONS,
  requireMetricDefinition,
  refreshSnapshots,
  type Dimension,
} from '@devanalytics/metrics';
import {
  NotFoundError,
  ValidationError,
  assertCan,
  assertOrgAccess,
  previousWindow,
  type Principal,
} from '@devanalytics/core';
import { appendAudit, getPullRequest, listPullRequests, scopeLabel, type Database } from '@devanalytics/db';
import { Investigator, runDetection, persistDetections } from '@devanalytics/investigations';
import { AiService, runGuardedQuery } from '@devanalytics/ai';
import type { IngestionService } from '@devanalytics/event-ingestion';
import { AuthChain } from './auth.js';
import { RateLimiter } from './rate-limit.js';
import { parseQuery, parseWindow } from './params.js';
import { Router, errorResponse, json, requireParam, type RouteContext } from './router.js';
import {
  listAnomalies, listDeployments, listEvents, listOrgRepositories, listTeams,
  listWorkflowRuns, organizationSummary, pullRequestDetail, repositoryHealth,
} from './queries.js';
import { investigationToMarkdown, seriesToCsv, seriesToJson, textToPdf, toCsv } from './export.js';

/**
 * The API.
 *
 * One route table, mounted by both the Next.js app and the standalone server.
 * Every handler that touches tenant data goes through `assertOrgAccess` and a
 * permission check before it reaches the database, and the database enforces
 * the same boundary again through row-level security.
 */

export interface ApiDeps {
  db: Database;
  engine: MetricEngine;
  investigator: Investigator;
  ai: AiService;
  auth: AuthChain;
  ingestion?: IngestionService;
  rateLimiter?: RateLimiter;
  /** Absolute base URL, used when generating webhook URLs. */
  baseUrl?: string;
}

export function createApi(deps: ApiDeps) {
  const limiter = deps.rateLimiter ?? new RateLimiter();
  const router = buildRouter(deps);

  return {
    router,
    async handle(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const matched = router.match(request.method, url.pathname);
      if (!matched) return json({ error: { code: 'not_found', message: `No route for ${request.method} ${url.pathname}` } }, 404);

      try {
        if (matched.route.public) {
          const result = await matched.route.handler({
            principal: { userId: 'anonymous', orgId: '', role: 'viewer', tokenId: null },
            params: matched.params, url, request,
          });
          return result instanceof Response ? result : json({ data: result });
        }

        const principal = await deps.auth.authenticate(request);
        await limiter.check(`${principal.orgId}:${principal.tokenId ?? principal.userId}`, matched.route.policy ?? 'read');

        const result = await matched.route.handler({ principal, params: matched.params, url, request });
        return result instanceof Response ? result : json({ data: result });
      } catch (err) {
        return errorResponse(err);
      }
    },
  };
}

function buildRouter(deps: ApiDeps): Router {
  const { db, engine, investigator, ai } = deps;
  const router = new Router();

  const orgOf = (ctx: RouteContext): string => {
    const requested = ctx.url.searchParams.get('orgId') ?? ctx.principal.orgId;
    assertOrgAccess(ctx.principal, requested);
    return requested;
  };

  const isDemo = async (orgId: string): Promise<boolean> =>
    (await db.withOrg(orgId, (sql) => sql.value<boolean>(`select is_demo from organizations where id = $1`, [orgId]), 'readonly')) ?? false;

  // ---------------------------------------------------------------- health --

  router.add({
    method: 'GET', pattern: '/api/v1/health', public: true, summary: 'Liveness and version.',
    handler: async () => ({ status: 'ok', version: '0.1.0', time: new Date().toISOString() }),
  });

  router.add({
    method: 'GET', pattern: '/api/v1/me', summary: 'The authenticated principal and its permissions.',
    handler: async (ctx) => ({
      userId: ctx.principal.userId, orgId: ctx.principal.orgId, role: ctx.principal.role,
      viaToken: ctx.principal.tokenId !== null,
    }),
  });

  router.add({
    method: 'GET', pattern: '/api/v1/organization', summary: 'Organization summary, including whether it holds demo data.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'org:read');
      const summary = await organizationSummary(db, orgOf(ctx));
      if (!summary) throw new NotFoundError('Organization', ctx.principal.orgId);
      return {
        id: summary.id, slug: summary.slug, name: summary.name,
        isDemo: summary.is_demo,
        dataSource: summary.is_demo ? 'synthetic_demo' : 'ingested',
        repositories: Number(summary.repositories),
        pullRequests: Number(summary.pull_requests),
        events: Number(summary.events),
        lastEventAt: summary.last_event_at ? new Date(summary.last_event_at).toISOString() : null,
      };
    },
  });

  // --------------------------------------------------------------- metrics --

  router.add({
    method: 'GET', pattern: '/api/v1/metrics', summary: 'Every metric definition: formula, source, window anchor, minimum sample, caveats.',
    handler: async () => ({ metrics: METRIC_IDS.map((id) => METRIC_DEFINITIONS[id]) }),
  });

  router.add({
    method: 'GET', pattern: '/api/v1/metrics/:metric', summary: 'One metric definition.',
    handler: async (ctx) => requireMetricDefinition(requireParam(ctx, 'metric')),
  });

  router.add({
    method: 'GET', pattern: '/api/v1/metrics/:metric/value', summary: 'Metric value over a window.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'metrics:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      return engine.value({
        orgId, metric: requireParam(ctx, 'metric'), scopeType: q.scopeType,
        scopeId: q.scopeId as string, window: q.window, filters: q.filters,
      });
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/metrics/:metric/compare', summary: 'Current window against the preceding equal-length window.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'metrics:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const result = await engine.comparison({
        orgId, metric: requireParam(ctx, 'metric'), scopeType: q.scopeType,
        scopeId: q.scopeId as string, window: q.window, filters: q.filters,
      });
      return { ...result, previousWindow: previousWindow(q.window) };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/metrics/:metric/series', summary: 'Bucketed history. Buckets with too little data report insufficient_data, never zero.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'metrics:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const points = await engine.series({
        orgId, metric: requireParam(ctx, 'metric'), scopeType: q.scopeType,
        scopeId: q.scopeId as string, window: q.window, filters: q.filters, granularity: q.granularity,
      });
      return { granularity: q.granularity, window: q.window, points };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/metrics/:metric/breakdown', summary: 'Metric sliced by repository, team, branch or author.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'metrics:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const dimension = (ctx.url.searchParams.get('dimension') ?? 'repository') as Dimension;
      if (!['repository', 'team', 'branch', 'author'].includes(dimension)) {
        throw new ValidationError(`Invalid dimension "${dimension}"`, { allowed: ['repository', 'team', 'branch', 'author'] });
      }
      const rows = await engine.breakdown(
        { orgId, metric: requireParam(ctx, 'metric'), scopeType: q.scopeType, scopeId: q.scopeId as string, window: q.window, filters: q.filters },
        dimension,
        q.limit,
      );
      return { dimension, rows };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/metrics/:metric/facts', summary: 'The individual observations behind a metric, for drill-down.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'metrics:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      return {
        facts: await engine.facts(
          { orgId, metric: requireParam(ctx, 'metric'), scopeType: q.scopeType, scopeId: q.scopeId as string, window: q.window, filters: q.filters },
          q.limit,
        ),
      };
    },
  });

  // ---------------------------------------------------------- repositories --

  router.add({
    method: 'GET', pattern: '/api/v1/repositories', summary: 'Connected repositories.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      return { repositories: await listOrgRepositories(db, orgOf(ctx)) };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/repositories/:id/health', summary: 'Named health metrics for a repository. Deliberately not a single score.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      const orgId = orgOf(ctx);
      const { window } = parseWindow(ctx.url);
      return repositoryHealth(db, engine, { orgId, repoId: requireParam(ctx, 'id'), window });
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/teams', summary: 'Teams, for aggregation. No individual rankings are exposed anywhere.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'org:read');
      return { teams: await listTeams(db, orgOf(ctx)) };
    },
  });

  // -------------------------------------------------------- pull requests --

  router.add({
    method: 'GET', pattern: '/api/v1/pull-requests', summary: 'Pull requests, filterable.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const opts: Parameters<typeof listPullRequests>[1] = { limit: q.limit, offset: q.offset };
      const repoId = ctx.url.searchParams.get('repositoryId');
      const state = ctx.url.searchParams.get('state');
      const author = ctx.url.searchParams.get('authorUserId');
      if (repoId) opts.repoId = repoId;
      if (state) opts.state = state;
      if (author) opts.authorUserId = author;
      return { pullRequests: await db.withOrg(orgId, (sql) => listPullRequests(sql, opts), 'readonly') };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/pull-requests/:id', summary: 'One pull request with its full timeline, reviews, CI runs and deployments.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      return pullRequestDetail(db, orgOf(ctx), requireParam(ctx, 'id'));
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/reviews', summary: 'Reviews for a pull request.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      const orgId = orgOf(ctx);
      const prId = ctx.url.searchParams.get('pullRequestId');
      if (!prId) throw new ValidationError('pullRequestId is required');
      return db.withOrg(orgId, async (sql) => {
        const pr = await getPullRequest(sql, prId);
        if (!pr) throw new NotFoundError('Pull request', prId);
        return {
          reviews: await sql.many(
            `select rv.id, rv.state, rv.submitted_at, rv.requested_at, u.login as reviewer
               from reviews rv left join users u on u.id = rv.reviewer_user_id
              where rv.pull_request_id = $1 order by rv.submitted_at`,
            [prId],
          ),
        };
      }, 'readonly');
    },
  });

  // ------------------------------------------------- CI, deploys, events ---

  router.add({
    method: 'GET', pattern: '/api/v1/ci/runs', summary: 'CI runs.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const opts: Parameters<typeof listWorkflowRuns>[2] = { limit: q.limit, offset: q.offset };
      const repoId = ctx.url.searchParams.get('repositoryId');
      const conclusion = ctx.url.searchParams.get('conclusion');
      if (repoId) opts.repoId = repoId;
      if (conclusion) opts.conclusion = conclusion;
      return { runs: await listWorkflowRuns(db, orgId, opts) };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/deployments', summary: 'Deployments.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const opts: Parameters<typeof listDeployments>[2] = {
        limit: q.limit, offset: q.offset, productionOnly: q.filters.productionOnly !== false,
      };
      const repoId = ctx.url.searchParams.get('repositoryId');
      if (repoId) opts.repoId = repoId;
      return { deployments: await listDeployments(db, orgId, opts) };
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/events', summary: 'Raw canonical events, for the data explorer.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'repo:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const opts: Parameters<typeof listEvents>[2] = { limit: q.limit, offset: q.offset };
      const type = ctx.url.searchParams.get('type');
      const repoId = ctx.url.searchParams.get('repositoryId');
      if (type) opts.type = type;
      if (repoId) opts.repoId = repoId;
      return { events: await listEvents(db, orgId, opts) };
    },
  });

  // ------------------------------------------------------------ anomalies --

  router.add({
    method: 'GET', pattern: '/api/v1/anomalies', summary: 'Detected anomalies with score, severity, confidence and sample sizes.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'metrics:read');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const opts: Parameters<typeof listAnomalies>[2] = { limit: q.limit };
      const status = ctx.url.searchParams.get('status');
      const metric = ctx.url.searchParams.get('metric');
      if (status) opts.status = status;
      if (metric) opts.metric = metric;
      return { anomalies: await listAnomalies(db, orgId, opts) };
    },
  });

  router.add({
    method: 'POST', pattern: '/api/v1/anomalies/:id/acknowledge', policy: 'write',
    summary: 'Acknowledge an anomaly.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'anomaly:acknowledge');
      const orgId = orgOf(ctx);
      const id = requireParam(ctx, 'id');
      const updated = await db.withOrg(orgId, async (sql) => {
        const res = await sql.query(`update anomalies set status = 'acknowledged' where id = $1 and status = 'open'`, [id]);
        await appendAudit(sql, {
          actorUserId: ctx.principal.userId, action: 'anomaly.acknowledge', resourceType: 'anomaly', resourceId: id,
        });
        return res.rowCount;
      });
      if (updated === 0) throw new NotFoundError('Open anomaly', id);
      return { id, status: 'acknowledged' };
    },
  });

  router.add({
    method: 'POST', pattern: '/api/v1/anomalies/detect', policy: 'write',
    summary: 'Run detection now across org and repository scopes.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'org:manage');
      const orgId = orgOf(ctx);
      const repos = await listOrgRepositories(db, orgId);
      const detections = await runDetection(db, engine, {
        orgId,
        scopes: [
          { scopeType: 'org', scopeId: orgId },
          ...repos.map((r) => ({ scopeType: 'repository' as const, scopeId: r.id })),
        ],
        granularity: (ctx.url.searchParams.get('granularity') as 'day' | 'week' | 'month') ?? 'week',
      });
      const saved = await persistDetections(db, orgId, detections);
      return {
        examined: detections.length,
        anomalies: saved,
        notDetected: detections.filter((d) => !d.isAnomaly).map((d) => ({ metric: d.metric, scopeId: d.scopeId, reason: d.reason, explanation: d.explanation })),
      };
    },
  });

  // ------------------------------------------------------- investigations --

  router.add({
    method: 'GET', pattern: '/api/v1/investigations', summary: 'Saved investigations.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'investigation:read');
      const orgId = orgOf(ctx);
      return {
        investigations: await db.withOrg(orgId, (sql) =>
          sql.many(`select id, metric, scope_type, scope_id, title, window_start, window_end, created_at from investigations order by created_at desc limit 100`),
          'readonly',
        ),
      };
    },
  });

  router.add({
    method: 'POST', pattern: '/api/v1/investigations', policy: 'write',
    summary: 'Run and persist an investigation of a metric change.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'investigation:create');
      const orgId = orgOf(ctx);
      const body = (await ctx.request.json().catch(() => ({}))) as Record<string, unknown>;
      const metric = typeof body.metric === 'string' ? body.metric : null;
      if (!metric) throw new ValidationError('"metric" is required');
      requireMetricDefinition(metric);
      const q = parseQuery(ctx.url, orgId);
      const scopeType = (typeof body.scopeType === 'string' ? body.scopeType : q.scopeType) as typeof q.scopeType;
      const scopeId = (typeof body.scopeId === 'string' ? body.scopeId : q.scopeId) as string;

      const report = await investigator.investigate({
        orgId, metric, scopeType, scopeId, window: q.window,
        ...(typeof body.anomalyId === 'string' ? { anomalyId: body.anomalyId } : {}),
      });
      await investigator.save(report, ctx.principal.userId, typeof body.anomalyId === 'string' ? body.anomalyId : null);
      await db.withOrg(orgId, (sql) =>
        appendAudit(sql, { actorUserId: ctx.principal.userId, action: 'investigation.create', resourceType: 'investigation', resourceId: report.id, detail: { metric } }),
      );
      return report;
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/investigations/:id', summary: 'One saved investigation with its findings.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'investigation:read');
      const orgId = orgOf(ctx);
      const id = requireParam(ctx, 'id');
      return db.withOrg(orgId, async (sql) => {
        const investigation = await sql.one(`select * from investigations where id = $1`, [id]);
        if (!investigation) throw new NotFoundError('Investigation', id);
        const findings = await sql.many(`select * from investigation_findings where investigation_id = $1 order by rank`, [id]);
        return { investigation, findings };
      }, 'readonly');
    },
  });

  // ------------------------------------------------------------------- AI --

  router.add({
    method: 'POST', pattern: '/api/v1/ai/query', policy: 'ai',
    summary: 'Ask a question. Answered from evidence the platform computed, with citations.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'ai:query');
      const orgId = orgOf(ctx);
      const body = (await ctx.request.json().catch(() => ({}))) as { question?: unknown };
      const question = typeof body.question === 'string' ? body.question.trim() : '';
      if (!question) throw new ValidationError('"question" is required');
      if (question.length > 1000) throw new ValidationError('"question" must be at most 1000 characters');
      await db.withOrg(orgId, (sql) =>
        appendAudit(sql, { actorUserId: ctx.principal.userId, action: 'ai.query', resourceType: 'ai_query', detail: { question } }),
      );
      return ai.ask(orgId, question);
    },
  });

  router.add({
    method: 'POST', pattern: '/api/v1/ai/sql', policy: 'ai',
    summary: 'Run a guarded read-only SELECT. Validated, allowlisted, row-capped, timed out and audited.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'ai:query');
      const orgId = orgOf(ctx);
      const body = (await ctx.request.json().catch(() => ({}))) as { sql?: unknown; maxRows?: unknown };
      const sql = typeof body.sql === 'string' ? body.sql : '';
      if (!sql) throw new ValidationError('"sql" is required');
      return runGuardedQuery(db, orgId, sql, {
        actorUserId: ctx.principal.userId,
        ...(typeof body.maxRows === 'number' ? { maxRows: body.maxRows } : {}),
      });
    },
  });

  // --------------------------------------------------------------- export --

  router.add({
    method: 'GET', pattern: '/api/v1/export/metrics/:metric', policy: 'export',
    summary: 'Export a metric series as CSV or JSON, with its definition and window embedded.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'data:export');
      const orgId = orgOf(ctx);
      const metric = requireParam(ctx, 'metric');
      requireMetricDefinition(metric);
      const q = parseQuery(ctx.url, orgId);
      const format = ctx.url.searchParams.get('format') ?? 'csv';
      const points = await engine.series({
        orgId, metric, scopeType: q.scopeType, scopeId: q.scopeId as string,
        window: q.window, filters: q.filters, granularity: q.granularity,
      });
      const label = await db.withOrg(orgId, (s) => scopeLabel(s, q.scopeType, q.scopeId as string), 'readonly');
      const demo = await isDemo(orgId);
      const input = {
        metric, scopeLabel: label, window: q.window, granularity: q.granularity,
        points, filtersApplied: q.filters as unknown as Record<string, unknown>, isDemo: demo,
      };
      await db.withOrg(orgId, (s) =>
        appendAudit(s, { actorUserId: ctx.principal.userId, action: 'data.export', resourceType: 'metric', resourceId: metric, detail: { format } }),
      );

      if (format === 'json') {
        return json(seriesToJson(input), 200, { 'content-disposition': `attachment; filename="${metric}.json"` });
      }
      if (format !== 'csv') throw new ValidationError(`Unsupported format "${format}"`, { allowed: ['csv', 'json'] });
      return new Response(seriesToCsv(input), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${metric}.csv"` },
      });
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/export/investigations/:id', policy: 'export',
    summary: 'Export a saved investigation as Markdown or PDF.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'data:export');
      const orgId = orgOf(ctx);
      const id = requireParam(ctx, 'id');
      const stored = await db.withOrg(orgId, (sql) =>
        sql.one<{ metric: string; scope_type: string; scope_id: string; window_start: Date; window_end: Date; baseline_start: Date; baseline_end: Date }>(
          `select metric, scope_type, scope_id, window_start, window_end, baseline_start, baseline_end from investigations where id = $1`,
          [id],
        ), 'readonly');
      if (!stored) throw new NotFoundError('Investigation', id);

      const report = await investigator.investigate({
        orgId, metric: stored.metric,
        scopeType: stored.scope_type as 'org', scopeId: stored.scope_id,
        window: { from: new Date(stored.window_start).toISOString(), to: new Date(stored.window_end).toISOString() },
        baselineWindow: { from: new Date(stored.baseline_start).toISOString(), to: new Date(stored.baseline_end).toISOString() },
      });
      const markdown = investigationToMarkdown(report, await isDemo(orgId));
      const format = ctx.url.searchParams.get('format') ?? 'markdown';
      if (format === 'pdf') {
        const pdf = textToPdf(report.title, markdown.replace(/[*_`>|]/g, ''));
        return new Response(pdf as unknown as BodyInit, {
          headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="investigation-${id}.pdf"` },
        });
      }
      if (format !== 'markdown') throw new ValidationError(`Unsupported format "${format}"`, { allowed: ['markdown', 'pdf'] });
      return new Response(markdown, {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="investigation-${id}.md"` },
      });
    },
  });

  router.add({
    method: 'GET', pattern: '/api/v1/export/pull-requests', policy: 'export',
    summary: 'Export pull requests as CSV.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'data:export');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      const rows = await db.withOrg(orgId, (sql) => listPullRequests(sql, { limit: Math.min(q.limit, 500), offset: q.offset }), 'readonly');
      return new Response(toCsv(rows as unknown as Record<string, unknown>[]), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="pull-requests.csv"' },
      });
    },
  });

  // -------------------------------------------------------------- webhooks --

  router.add({
    method: 'POST', pattern: '/api/v1/webhooks/:provider/:endpointId', public: true, policy: 'webhook',
    summary: 'Provider webhook receiver. Verifies the signature, records the delivery and enqueues; does no analytics.',
    handler: async (ctx) => {
      if (!deps.ingestion) return json({ error: { code: 'not_configured', message: 'Ingestion is not configured' } }, 503);
      const body = await ctx.request.text();
      const headers: Record<string, string | undefined> = {};
      ctx.request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

      const outcome = await deps.ingestion.receive({
        provider: requireParam(ctx, 'provider') as 'github',
        endpointId: requireParam(ctx, 'endpointId'),
        body,
        headers,
        receivedAt: new Date().toISOString(),
      });

      const status = outcome.status === 'rejected'
        ? (outcome.reason === 'invalid_signature' ? 401 : 400)
        : 202;
      return json({ data: outcome }, status);
    },
  });

  // ------------------------------------------------------------- snapshots --

  router.add({
    method: 'POST', pattern: '/api/v1/admin/snapshots/refresh', policy: 'write',
    summary: 'Recompute metric snapshots over a window.',
    handler: async (ctx) => {
      assertCan(ctx.principal, 'org:manage');
      const orgId = orgOf(ctx);
      const q = parseQuery(ctx.url, orgId);
      return refreshSnapshots(db, engine, { orgId, window: q.window, granularity: q.granularity });
    },
  });

  // --------------------------------------------------------------- openapi --

  router.add({
    method: 'GET', pattern: '/api/v1/openapi.json', public: true, summary: 'Machine-readable description of this API.',
    handler: async () => openApiDocument(router),
  });

  return router;
}

export function openApiDocument(router: Router) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of router.list()) {
    const path = route.pattern.replace(/:([a-zA-Z]+)/g, '{$1}');
    paths[path] ??= {};
    const params = [...route.pattern.matchAll(/:([a-zA-Z]+)/g)].map((m) => ({
      name: m[1], in: 'path', required: true, schema: { type: 'string' },
    }));
    (paths[path] as Record<string, unknown>)[route.method.toLowerCase()] = {
      summary: route.summary,
      security: route.public ? [] : [{ bearerAuth: [] }],
      parameters: params,
      responses: {
        '200': { description: 'Success' },
        '400': { description: 'Invalid request' },
        '401': { description: 'Unauthorized' },
        '403': { description: 'Forbidden' },
        '429': { description: 'Rate limited' },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'DevAnalytics API',
      version: '0.1.0',
      description:
        'Engineering intelligence API. Metric values are either computed from ingested events or returned as insufficient_data with their sample size; no endpoint returns an estimated or placeholder number.',
    },
    servers: [{ url: '/' }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token, e.g. dva_abcd1234_...' } },
    },
    paths,
  };
}

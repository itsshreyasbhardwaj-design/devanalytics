import { z } from 'zod';
import { DevAnalytics, type Dimension, type Granularity, type Period, type ScopeType } from '@devanalytics/sdk';

/**
 * MCP server.
 *
 * Read-only by construction: the tool list contains no mutating operation, and
 * the underlying credential is an API token whose role can be set to `viewer`,
 * so an agent cannot acknowledge anomalies, create investigations, connect
 * repositories or run SQL even by guessing endpoint names.
 *
 * Tool results deliberately keep `insufficient_data` intact. An agent reasoning
 * over these tools is told when there is not enough data, and cannot mistake a
 * missing period for a zero.
 */

const scopeSchema = z.object({
  scopeType: z.enum(['org', 'repository', 'team', 'branch', 'developer']).optional().describe('Aggregation level. Defaults to the whole organization.'),
  scopeId: z.string().optional().describe('Id of the repository, team, branch or developer when scopeType is not "org".'),
});

const windowSchema = z.object({
  period: z.enum(['1d', '7d', '30d', '90d', '365d']).optional().describe('Relative window ending now. Defaults to 30d.'),
  from: z.string().optional().describe('ISO-8601 start of an explicit window (inclusive).'),
  to: z.string().optional().describe('ISO-8601 end of an explicit window (exclusive).'),
});

const filterSchema = z.object({
  repositoryId: z.array(z.string()).optional(),
  teamId: z.array(z.string()).optional(),
  branch: z.array(z.string()).optional(),
  excludeBots: z.boolean().optional().describe('Exclude bot-authored pull requests and commits. Defaults to true.'),
  productionOnly: z.boolean().optional().describe('Restrict deployment metrics to production environments. Defaults to true.'),
});

export interface McpToolDefinition {
  name: string;
  description: string;
  /** Zod object; its `shape` is handed to the MCP SDK as the tool's input schema. */
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export function buildTools(client: DevAnalytics): McpToolDefinition[] {
  const query = (a: Record<string, unknown>) => ({
    scopeType: a.scopeType as ScopeType | undefined,
    scopeId: a.scopeId as string | undefined,
    period: a.period as Period | undefined,
    from: a.from as string | undefined,
    to: a.to as string | undefined,
    granularity: a.granularity as Granularity | undefined,
    repositoryId: a.repositoryId as string[] | undefined,
    teamId: a.teamId as string[] | undefined,
    branch: a.branch as string[] | undefined,
    excludeBots: a.excludeBots as boolean | undefined,
    productionOnly: a.productionOnly as boolean | undefined,
    limit: a.limit as number | undefined,
  });

  return [
    {
      name: 'list_metrics',
      description:
        'List every metric this platform computes, with its formula, data source, time anchor, minimum sample size and caveats. Call this first: only these metric ids are valid elsewhere.',
      schema: z.object({}),
      handler: async () => client.metrics.list(),
    },
    {
      name: 'get_metric',
      description:
        'Get one metric value over a window. The result is either {status:"ok", value, sampleSize} or {status:"insufficient_data", reason, sampleSize, minimumSampleSize}. Never treat insufficient_data as zero.',
      schema: z.object({ metric: z.string().describe('Metric id from list_metrics.') }).merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => client.metrics.get(a.metric as string, query(a)),
    },
    {
      name: 'compare_metric',
      description: 'Compare a metric between a window and the equal-length window immediately before it. Returns both values, their sample sizes and the relative change.',
      schema: z.object({ metric: z.string() }).merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => client.metrics.compare(a.metric as string, query(a)),
    },
    {
      name: 'get_metric_series',
      description: 'Get a bucketed time series for a metric. Buckets with too few observations report insufficient_data and must be rendered as gaps, not zeros.',
      schema: z
        .object({ metric: z.string(), granularity: z.enum(['day', 'week', 'month']).optional() })
        .merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => client.metrics.series(a.metric as string, query(a)),
    },
    {
      name: 'get_repository_metrics',
      description: 'Get the full named health metric set for one repository. There is no single composite score; each metric is reported separately with its own sample size.',
      schema: z.object({ repositoryId: z.string() }).merge(windowSchema),
      handler: async (a) => client.repositories.health(a.repositoryId as string, query(a)),
    },
    {
      name: 'list_repositories',
      description: 'List connected repositories with their ids, for use as scopeId elsewhere.',
      schema: z.object({}),
      handler: async () => client.repositories.list(),
    },
    {
      name: 'get_pr_metrics',
      description: 'Get pull-request delivery metrics (cycle time, time to first review, review turnaround, merge time, size, review participation) for a scope.',
      schema: z.object({}).merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => {
        const metrics = ['pr_cycle_time', 'time_to_first_review', 'review_turnaround_time', 'merge_time', 'pr_size', 'review_participation', 'reopened_pr_rate'];
        const values = await Promise.all(metrics.map((m) => client.metrics.get(m, query(a))));
        return { metrics: values };
      },
    },
    {
      name: 'get_ci_metrics',
      description: 'Get CI metrics (build success rate, build duration, CI queue time) for a scope. Build duration excludes queue time; they are reported separately on purpose.',
      schema: z.object({}).merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => {
        const metrics = ['build_success_rate', 'build_duration', 'ci_queue_time'];
        const values = await Promise.all(metrics.map((m) => client.metrics.get(m, query(a))));
        return { metrics: values };
      },
    },
    {
      name: 'get_deployment_metrics',
      description: 'Get deployment metrics (deployment frequency, lead time for changes, failed deployment rate) for a scope.',
      schema: z.object({}).merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => {
        const metrics = ['deployment_frequency', 'lead_time_for_changes', 'failed_deployment_rate'];
        const values = await Promise.all(metrics.map((m) => client.metrics.get(m, query(a))));
        return { metrics: values };
      },
    },
    {
      name: 'breakdown_metric',
      description: 'Slice a metric by repository, team, branch or author to see where a value comes from. Use contributions from get_investigation for change attribution instead of comparing slices by eye.',
      schema: z
        .object({ metric: z.string(), dimension: z.enum(['repository', 'team', 'branch', 'author']) })
        .merge(scopeSchema).merge(windowSchema).merge(filterSchema),
      handler: async (a) => client.metrics.breakdown(a.metric as string, a.dimension as Dimension, query(a)),
    },
    {
      name: 'list_anomalies',
      description:
        'List detected anomalies. Each carries a robust score, severity, confidence and both sample sizes, so a thin period can be discounted. Detection uses each scope\'s own history, not fixed thresholds.',
      schema: z.object({
        status: z.enum(['open', 'acknowledged', 'resolved']).optional(),
        metric: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (a) => client.anomalies.list({ ...query(a), status: a.status as string | undefined, metric: a.metric as string | undefined }),
    },
    {
      name: 'get_investigation',
      description:
        'Get a saved investigation: the arithmetic decomposition of a metric change by repository, team, branch and author, plus related metrics that moved alongside it. Contributions are exact shares of the measured delta; related metrics are associations, not causes.',
      schema: z.object({ investigationId: z.string() }),
      handler: async (a) => client.investigations.get(a.investigationId as string),
    },
    {
      name: 'list_investigations',
      description: 'List saved investigations with their metric, scope and window.',
      schema: z.object({}),
      handler: async () => client.investigations.list(),
    },
    {
      name: 'search_engineering_events',
      description:
        'Search the canonical event log (pushes, pull request transitions, reviews, CI runs, deployments) to trace a metric back to the raw records it came from.',
      schema: z.object({
        type: z.string().optional().describe('Canonical event type, e.g. pull_request.merged or workflow_run.completed.'),
        repositoryId: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
      handler: async (a) => client.events.list({ ...query(a), type: a.type as string | undefined }),
    },
    {
      name: 'list_pull_requests',
      description: 'List pull requests with their review and merge timestamps, for drilling into a metric.',
      schema: z.object({
        repositoryId: z.string().optional(),
        state: z.enum(['open', 'closed', 'merged']).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }).merge(windowSchema),
      handler: async (a) => client.pullRequests.list({ ...query(a), state: a.state as string | undefined }),
    },
    {
      name: 'get_pull_request',
      description: 'Get one pull request with its full timeline: commits, reviews, comments, CI runs and deployments in order.',
      schema: z.object({ pullRequestId: z.string() }),
      handler: async (a) => client.pullRequests.get(a.pullRequestId as string),
    },
    {
      name: 'ask_devanalytics',
      description:
        'Ask a natural-language question about engineering metrics. The answer is assembled from values this platform computed and carries citations naming the metric, scope, window and sample size behind every claim. Prefer this for "why did X change" questions.',
      schema: z.object({ question: z.string().max(1000) }),
      handler: async (a) => client.ai.query(a.question as string),
    },
  ];
}

/** Tool names that would mutate state. Asserted empty by the test suite. */
export const MUTATING_TOOL_PATTERNS = [
  /^(create|update|delete|remove|set|write|acknowledge|connect|disconnect|run_sql|execute|refresh|detect)/i,
];

export function findMutatingTools(tools: McpToolDefinition[]): string[] {
  return tools.filter((t) => MUTATING_TOOL_PATTERNS.some((p) => p.test(t.name))).map((t) => t.name);
}

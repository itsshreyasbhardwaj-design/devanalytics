import { AiService, OpenRouterClient, DisabledLlmClient, type LlmClient } from '@devanalytics/ai';
import { ApiTokenAuthProvider, AuthChain, ClerkAuthProvider, LocalDevAuthProvider, RateLimiter, createApi, type ApiDeps } from '@devanalytics/api';
import { Database } from '@devanalytics/db';
import { DefaultProviderRegistry, EventWorker, IngestionService, PostgresJobQueue, RedisJobQueue, type JobQueue, type RedisLike } from '@devanalytics/event-ingestion';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { GitLabWebhookAdapter } from '@devanalytics/gitlab';
import { Investigator } from '@devanalytics/investigations';
import { MetricEngine } from '@devanalytics/metrics';

/**
 * Composition root.
 *
 * Wiring lives here so the Next.js app, the standalone API server, the worker
 * and the test suite all construct the same object graph from the same
 * environment, rather than each assembling its own slightly different one.
 */

export interface RuntimeConfig {
  databaseUrl?: string | undefined;
  /** Directory for the embedded database. Omit for in-memory. */
  embeddedDataDir?: string | undefined;
  redisUrl?: string | undefined;
  openRouterApiKey?: string | undefined;
  authMode: 'clerk' | 'local-dev';
  localDevOrgId?: string | undefined;
  baseUrl: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const authMode = env.DEVANALYTICS_AUTH_MODE === 'local-dev' ? 'local-dev' : 'clerk';
  if (authMode === 'local-dev' && env.NODE_ENV === 'production') {
    throw new Error('DEVANALYTICS_AUTH_MODE=local-dev must never be used in production.');
  }
  return {
    databaseUrl: env.DATABASE_URL,
    embeddedDataDir: env.DEVANALYTICS_EMBEDDED_DATA_DIR,
    redisUrl: env.REDIS_URL,
    openRouterApiKey: env.OPENROUTER_API_KEY,
    authMode,
    localDevOrgId: env.DEVANALYTICS_LOCAL_ORG_ID,
    baseUrl: env.DEVANALYTICS_BASE_URL ?? 'http://localhost:3117',
  };
}

export interface Runtime {
  db: Database;
  engine: MetricEngine;
  investigator: Investigator;
  ai: AiService;
  queue: JobQueue;
  ingestion: IngestionService;
  worker: EventWorker;
  registry: DefaultProviderRegistry;
  api: ReturnType<typeof createApi>;
  config: RuntimeConfig;
  close(): Promise<void>;
}

/**
 * Postgres when DATABASE_URL is set, the embedded engine otherwise. The
 * embedded path is a real Postgres 16, not a mock, so local development
 * exercises the same SQL as production.
 */
async function openDatabase(config: RuntimeConfig): Promise<Database> {
  const db = config.databaseUrl
    ? await Database.postgres(config.databaseUrl)
    : await Database.pglite(config.embeddedDataDir);
  await db.migrate();
  return db;
}

async function openQueue(db: Database, config: RuntimeConfig): Promise<JobQueue> {
  const durable = new PostgresJobQueue(db);
  if (!config.redisUrl) return durable;
  try {
    // Built at runtime so bundlers do not try to resolve an optional
    // dependency that most deployments never install.
    const specifier = ['io', 'redis'].join('');
    const mod = (await import(/* webpackIgnore: true */ specifier)) as { default: new (url: string) => RedisLike };
    return new RedisJobQueue(new mod.default(config.redisUrl), durable);
  } catch {
    // Redis is a latency optimisation, not the system of record. Losing it
    // degrades dispatch speed and nothing else.
    process.stderr.write('REDIS_URL is set but ioredis is unavailable; using the durable Postgres queue.\n');
    return durable;
  }
}

function openLlm(config: RuntimeConfig): LlmClient {
  return config.openRouterApiKey ? new OpenRouterClient({ apiKey: config.openRouterApiKey }) : new DisabledLlmClient();
}

export async function createRuntime(config: RuntimeConfig = readConfig()): Promise<Runtime> {
  const db = await openDatabase(config);
  const engine = new MetricEngine(db);
  const investigator = new Investigator(db, engine);
  const ai = new AiService(db, engine, openLlm(config), investigator);
  const queue = await openQueue(db, config);

  const registry = new DefaultProviderRegistry()
    .registerWebhook(new GitHubWebhookAdapter())
    .registerWebhook(new GitLabWebhookAdapter());
  const ingestion = new IngestionService({ db, queue, adapters: registry.adapterMap });
  const worker = new EventWorker(db, queue);

  const providers: ApiDeps['auth'] = new AuthChain([
    new ApiTokenAuthProvider(db),
    ...(config.authMode === 'clerk' ? [new ClerkAuthProvider(db, createClerkVerifier())] : []),
    ...(config.authMode === 'local-dev' && config.localDevOrgId ? [new LocalDevAuthProvider(config.localDevOrgId)] : []),
  ]);

  const api = createApi({
    db, engine, investigator, ai, ingestion,
    auth: providers,
    rateLimiter: new RateLimiter(),
    baseUrl: config.baseUrl,
  });

  return {
    db, engine, investigator, ai, queue, ingestion, worker, registry, api, config,
    async close() {
      await db.close();
    },
  };
}

/**
 * Clerk session verification.
 *
 * Delegated to Clerk's own API rather than reimplemented. Membership and role
 * still come from our `org_members` table; the verifier only establishes who
 * the caller is.
 */
function createClerkVerifier() {
  const secretKey = process.env.CLERK_SECRET_KEY;
  return {
    async verify(sessionToken: string) {
      if (!secretKey) return null;
      try {
        const res = await fetch('https://api.clerk.com/v1/sessions/verify', {
          method: 'POST',
          headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ token: sessionToken }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { user_id?: string };
        return body.user_id ? { subject: body.user_id, email: null } : null;
      } catch {
        return null;
      }
    },
  };
}

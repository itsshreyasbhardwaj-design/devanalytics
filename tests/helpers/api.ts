import { AiService } from '@devanalytics/ai';
import { AuthChain, createApi, type ApiDeps } from '@devanalytics/api';
import { ApiTokenAuthProvider } from '@devanalytics/api';
import { generateApiToken, hashToken, type Database } from '@devanalytics/db';
import { EventWorker, IngestionService, PostgresJobQueue } from '@devanalytics/event-ingestion';
import { GitHubWebhookAdapter } from '@devanalytics/github';
import { GitLabWebhookAdapter } from '@devanalytics/gitlab';
import { Investigator } from '@devanalytics/investigations';
import { MetricEngine } from '@devanalytics/metrics';
import { DevAnalytics } from '@devanalytics/sdk';

export interface TestApi {
  handle: (request: Request) => Promise<Response>;
  engine: MetricEngine;
  queue: PostgresJobQueue;
  worker: EventWorker;
  ingestion: IngestionService;
  deps: ApiDeps;
  /** Base URL the in-process fetch shim answers on. */
  baseUrl: string;
  fetchImpl: typeof fetch;
}

/** Creates an issued API token for an org, returning the plaintext once. */
export async function issueToken(
  db: Database,
  orgId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  name = 'test',
): Promise<string> {
  const { token, prefix } = generateApiToken();
  await db.unscoped((sql) =>
    sql.query(
      `insert into principals (id, auth_provider, auth_subject, email) values ($1,'test',$1,null) on conflict do nothing`,
      [`principal-${orgId}-${role}`],
    ),
  );
  await db.withOrg(orgId, (sql) =>
    sql.query(
      `insert into api_tokens (id, org_id, principal_id, name, token_hash, token_prefix, role)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [`token-${orgId}-${role}-${name}`, orgId, `principal-${orgId}-${role}`, name, hashToken(token), prefix, role],
    ),
  );
  return token;
}

export interface TestEndpoint {
  endpointId: string;
  orgId: string;
  secret: string;
  provider?: 'github' | 'gitlab';
}

export function createTestApi(db: Database, endpointSecret?: TestEndpoint | TestEndpoint[]): TestApi {
  const engine = new MetricEngine(db);
  const investigator = new Investigator(db, engine);
  const ai = new AiService(db, engine, undefined, investigator);
  const queue = new PostgresJobQueue(db);
  const endpoints = endpointSecret ? (Array.isArray(endpointSecret) ? endpointSecret : [endpointSecret]) : [];
  const ingestion = new IngestionService({
    db,
    queue,
    adapters: new Map([
      ['github', new GitHubWebhookAdapter()],
      ['gitlab', new GitLabWebhookAdapter() as unknown as GitHubWebhookAdapter],
    ]),
    ...(endpoints.length > 0
      ? {
          lookupEndpoint: async (id: string) => {
            const match = endpoints.find((e) => e.endpointId === id);
            return match ? { id, orgId: match.orgId, provider: match.provider ?? 'github', secret: match.secret } : null;
          },
        }
      : {}),
  });

  const deps: ApiDeps = {
    db,
    engine,
    investigator,
    ai,
    auth: new AuthChain([new ApiTokenAuthProvider(db)]),
    ingestion,
  };
  const api = createApi(deps);
  const baseUrl = 'http://api.test';

  // In-process fetch: exercises the real route table, real auth and real
  // serialisation, without binding a port.
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return api.handle(request);
  };

  return {
    handle: api.handle,
    engine,
    queue,
    worker: new EventWorker(db, queue, 'test-worker'),
    ingestion,
    deps,
    baseUrl,
    fetchImpl,
  };
}

export function sdkFor(api: TestApi, token: string): DevAnalytics {
  return new DevAnalytics({ apiKey: token, baseUrl: api.baseUrl, fetchImpl: api.fetchImpl, maxRetries: 0 });
}

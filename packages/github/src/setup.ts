import { randomBytes } from 'node:crypto';
import { encryptSecret, upsertRepository, type Database } from '@devanalytics/db';
import { stableId, type Provider } from '@devanalytics/core';

/**
 * Connecting a repository.
 *
 * A webhook endpoint is an (unguessable id, encrypted secret) pair. The id
 * goes in the URL so the secret can be found before the body is parsed; the
 * secret is generated here and shown to the operator exactly once.
 */

export interface WebhookEndpoint {
  id: string;
  url: string;
  /** Returned once, at creation. Never readable again. */
  secret: string;
}

export async function createWebhookEndpoint(
  db: Database,
  input: { orgId: string; provider: Provider; baseUrl: string; description?: string },
): Promise<WebhookEndpoint> {
  const id = randomBytes(16).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  await db.withOrg(input.orgId, (sql) =>
    sql.query(
      `insert into webhook_endpoints (id, org_id, provider, secret_enc, description) values ($1,$2,$3,$4,$5)`,
      [id, input.orgId, input.provider, encryptSecret(secret), input.description ?? ''],
    ),
  );
  return { id, url: `${input.baseUrl.replace(/\/$/, '')}/api/v1/webhooks/${input.provider}/${id}`, secret };
}

export async function revokeWebhookEndpoint(db: Database, orgId: string, endpointId: string): Promise<void> {
  await db.withOrg(orgId, (sql) =>
    sql.query(`update webhook_endpoints set revoked_at = now() where id = $1`, [endpointId]),
  );
}

export interface ConnectRepositoryInput {
  orgId: string;
  provider: Provider;
  providerRepoId: string;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  teamId?: string | null;
}

export async function connectRepository(db: Database, input: ConnectRepositoryInput): Promise<{ repoId: string }> {
  const name = input.fullName.split('/')[1] ?? input.fullName;
  const repo = await db.withOrg(input.orgId, (sql) =>
    upsertRepository(sql, {
      provider: input.provider,
      providerRepoId: input.providerRepoId,
      name,
      fullName: input.fullName,
      defaultBranch: input.defaultBranch,
      isPrivate: input.isPrivate,
      teamId: input.teamId ?? null,
    }),
  );
  return { repoId: repo.id };
}

/** Which webhook events a connected repository needs to subscribe to. */
export const REQUIRED_GITHUB_EVENTS = [
  'push',
  'pull_request',
  'pull_request_review',
  'pull_request_review_comment',
  'workflow_run',
  'deployment',
  'deployment_status',
] as const;

export function githubWebhookConfig(endpoint: WebhookEndpoint) {
  return {
    name: 'web',
    active: true,
    events: [...REQUIRED_GITHUB_EVENTS],
    config: { url: endpoint.url, content_type: 'json', secret: endpoint.secret, insecure_ssl: '0' },
  };
}

export function deterministicEndpointId(orgId: string, provider: string, salt: string): string {
  return stableId('endpoint', orgId, provider, salt);
}

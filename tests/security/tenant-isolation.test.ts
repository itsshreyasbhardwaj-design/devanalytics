import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac } from 'node:crypto';
import { provisionOrganization, upsertRepository, type Database } from '@devanalytics/db';
import { loadFixture, type FixtureIds } from '@devanalytics/demo-data';
import { testDatabase } from '../helpers/db.js';
import { createTestApi, issueToken, sdkFor, type TestApi } from '../helpers/api.js';

const SECRET = 'endpoint-secret-under-test';
const ENDPOINT_ID = 'endpoint-secure';

describe('tenant isolation through the HTTP layer', () => {
  let db: Database;
  let api: TestApi;
  let victim: FixtureIds;
  let attackerOrgId: string;
  let attackerToken: string;
  let victimToken: string;
  let victimPrId: string;

  beforeAll(async () => {
    db = await testDatabase();
    victim = await loadFixture(db);
    const attacker = await provisionOrganization(db, { slug: 'attacker-co', name: 'Attacker Co' });
    attackerOrgId = attacker.id;
    await db.withOrg(attackerOrgId, (sql) =>
      upsertRepository(sql, {
        provider: 'github', providerRepoId: '4242', name: 'own', fullName: 'attacker-co/own',
        defaultBranch: 'main', isPrivate: true,
      }),
    );
    api = createTestApi(db, { endpointId: ENDPOINT_ID, orgId: victim.orgId, secret: SECRET });
    attackerToken = await issueToken(db, attackerOrgId, 'owner', 'attacker');
    victimToken = await issueToken(db, victim.orgId, 'owner', 'victim');
    victimPrId = victim.prIds[1] as string;
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const asAttacker = (path: string, method = 'GET') =>
    api.handle(new Request(`http://api.test${path}`, { method, headers: { authorization: `Bearer ${attackerToken}` } }));

  it('refuses a request that names another organization', async () => {
    const res = await asAttacker(`/api/v1/repositories?orgId=${victim.orgId}`);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toMatch(/Cross-organization/);
  });

  it('never returns another organization repositories', async () => {
    const sdk = sdkFor(api, attackerToken);
    const { repositories } = await sdk.repositories.list();
    expect(repositories.map((r) => r.fullName)).toEqual(['attacker-co/own']);
  });

  it('returns 404, not data, for another organization pull request id', async () => {
    const res = await asAttacker(`/api/v1/pull-requests/${victimPrId}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for another organization repository health', async () => {
    const res = await asAttacker(`/api/v1/repositories/${victim.repoId}/health`);
    expect(res.status).toBe(404);
  });

  it('computes metrics only over the caller organization', async () => {
    const attackerSdk = sdkFor(api, attackerToken);
    const victimSdk = sdkFor(api, victimToken);
    const window = { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' };

    const attackerValue = await attackerSdk.metrics.get('pr_cycle_time', window);
    const victimValue = await victimSdk.metrics.get('pr_cycle_time', window);

    expect(attackerValue.result).toMatchObject({ status: 'insufficient_data', sampleSize: 0 });
    expect(victimValue.result).toMatchObject({ status: 'ok', sampleSize: 5 });
  });

  it('cannot reach another organization through a metric breakdown', async () => {
    const sdk = sdkFor(api, attackerToken);
    const breakdown = await sdk.metrics.breakdown('pr_cycle_time', 'repository', {
      from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z',
    });
    expect(breakdown.rows).toEqual([]);
  });

  it('cannot scope a metric to another organization repository id', async () => {
    const res = await asAttacker(
      `/api/v1/metrics/pr_cycle_time/value?scopeType=repository&scopeId=${victim.repoId}&from=2026-03-01T00:00:00Z&to=2026-03-08T00:00:00Z`,
    );
    // The row-level policy makes the foreign scope simply empty.
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.result).toMatchObject({ status: 'insufficient_data', sampleSize: 0 });
  });

  it('cannot read another organization investigations or anomalies', async () => {
    const victimSdk = sdkFor(api, victimToken);
    await victimSdk.investigations.create(
      { metric: 'pr_cycle_time', scopeType: 'org', scopeId: victim.orgId },
      { from: '2026-03-01T00:00:00.000Z', to: '2026-03-08T00:00:00.000Z' },
    );
    const attackerSdk = sdkFor(api, attackerToken);
    const { investigations } = await attackerSdk.investigations.list();
    expect(investigations).toEqual([]);
    const { anomalies } = await attackerSdk.anomalies.list();
    expect(anomalies).toEqual([]);
  });

  it('cannot export another organization data', async () => {
    const res = await asAttacker(
      `/api/v1/export/metrics/pr_cycle_time?from=2026-03-01T00:00:00Z&to=2026-03-08T00:00:00Z&orgId=${victim.orgId}`,
    );
    expect(res.status).toBe(403);
  });

  it('cannot ask the AI layer about another organization', async () => {
    const sdk = sdkFor(api, attackerToken);
    const answer = await sdk.ai.query('Why did PR cycle time increase?');
    const text = JSON.stringify(answer);
    expect(text).not.toContain('fixture-co');
    expect(text).not.toContain('alice');
  });

  it('does not accept another organization token for its own org id', async () => {
    const res = await api.handle(
      new Request(`http://api.test/api/v1/repositories?orgId=${attackerOrgId}`, {
        headers: { authorization: `Bearer ${victimToken}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('stops accepting a revoked token', async () => {
    const doomed = await issueToken(db, attackerOrgId, 'owner', 'doomed');
    const before = await api.handle(new Request('http://api.test/api/v1/me', { headers: { authorization: `Bearer ${doomed}` } }));
    expect(before.status).toBe(200);

    await db.withOrg(attackerOrgId, (sql) => sql.query(`update api_tokens set revoked_at = now() where name = 'doomed'`));
    const after = await api.handle(new Request('http://api.test/api/v1/me', { headers: { authorization: `Bearer ${doomed}` } }));
    expect(after.status).toBe(401);
  });

  it('never returns a token, secret or ciphertext in any response', async () => {
    const victimSdk = sdkFor(api, victimToken);
    const payloads = await Promise.all([
      api.handle(new Request('http://api.test/api/v1/me', { headers: { authorization: `Bearer ${victimToken}` } })).then((r) => r.text()),
      api.handle(new Request('http://api.test/api/v1/organization', { headers: { authorization: `Bearer ${victimToken}` } })).then((r) => r.text()),
      victimSdk.repositories.list().then((r) => JSON.stringify(r)),
      victimSdk.events.list({ limit: 20 }).then((r) => JSON.stringify(r)),
    ]);
    for (const body of payloads) {
      expect(body).not.toMatch(/dva_[a-f0-9]{8}_/);
      expect(body).not.toMatch(/secret_enc|access_token_enc|webhook_secret/);
      expect(body).not.toMatch(/^v1\.|"v1\./);
      expect(body).not.toContain(SECRET);
    }
  });
});

describe('webhook spoofing', () => {
  let db: Database;
  let api: TestApi;
  let orgId: string;

  const body = JSON.stringify({
    action: 'opened',
    pull_request: {
      id: 1, number: 1, title: 'spoof', state: 'open', draft: false,
      created_at: '2026-03-01T00:00:00Z', updated_at: '2026-03-01T00:00:00Z',
      merged_at: null, closed_at: null, additions: 1, deletions: 0, changed_files: 1, commits: 1,
      base: { ref: 'main' }, head: { ref: 'x' }, user: { id: 1, login: 'attacker', type: 'User' },
    },
    repository: { id: 1, name: 'app', full_name: 'fixture-co/app', default_branch: 'main', private: true, owner: { login: 'fixture-co' } },
    organization: { login: 'fixture-co' },
  });

  beforeAll(async () => {
    db = await testDatabase();
    const fixture = await loadFixture(db);
    orgId = fixture.orgId;
    api = createTestApi(db, { endpointId: ENDPOINT_ID, orgId, secret: SECRET });
  }, 180_000);

  afterAll(async () => {
    await db.close();
  });

  const post = (headers: Record<string, string>, endpointId = ENDPOINT_ID, payload = body) =>
    api.handle(new Request(`http://api.test/api/v1/webhooks/github/${endpointId}`, { method: 'POST', body: payload, headers }));

  const eventCount = () =>
    db.withOrg(orgId, (sql) => sql.value<number>(`select count(*)::int from events`)).then((n) => Number(n));

  it('rejects an unsigned delivery', async () => {
    const before = await eventCount();
    const res = await post({ 'x-github-event': 'pull_request', 'x-github-delivery': 'a' });
    expect(res.status).toBe(401);
    expect(await eventCount()).toBe(before);
  });

  it('rejects a wrongly-signed delivery', async () => {
    const res = await post({
      'x-github-event': 'pull_request', 'x-github-delivery': 'b',
      'x-hub-signature-256': `sha256=${createHmac('sha256', 'wrong-secret').update(body).digest('hex')}`,
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unsupported signature algorithm', async () => {
    const res = await post({
      'x-github-event': 'pull_request', 'x-github-delivery': 'c',
      'x-hub-signature-256': `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}`,
    });
    expect(res.status).toBe(401);
  });

  it('rejects a valid signature presented to a different endpoint id', async () => {
    const res = await post(
      {
        'x-github-event': 'pull_request', 'x-github-delivery': 'd',
        'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
      },
      'some-other-endpoint',
    );
    expect(res.status).toBe(401);
  });

  it('rejects a body altered after signing', async () => {
    const signature = `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const tampered = body.replace('"spoof"', '"tampered"');
    const res = await post({ 'x-github-event': 'pull_request', 'x-github-delivery': 'e', 'x-hub-signature-256': signature }, ENDPOINT_ID, tampered);
    expect(res.status).toBe(401);
  });

  it('does not store the body of a rejected delivery', async () => {
    await post({ 'x-github-event': 'pull_request', 'x-github-delivery': 'f' });
    const rows = await db.unscoped((sql) =>
      sql.query<{ signature_valid: boolean; body: string | null }>(`select signature_valid, body from webhook_deliveries where delivery_id = 'f'`),
    );
    expect(rows.rows[0]?.signature_valid).toBe(false);
    expect(rows.rows[0]?.body).toBeNull();
  });

  it('accepts a correctly signed delivery', async () => {
    const before = await eventCount();
    const res = await post({
      'x-github-event': 'pull_request', 'x-github-delivery': 'good',
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    });
    expect(res.status).toBe(202);
    expect(await eventCount()).toBe(before + 1);
  });

  it('requires no authentication but is still not an open write path', async () => {
    // The endpoint is public by necessity; the signature is the credential.
    const res = await post({ 'x-github-event': 'pull_request', 'x-github-delivery': 'g', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) });
    expect(res.status).toBe(401);
  });
});

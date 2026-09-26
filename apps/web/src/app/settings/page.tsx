import Link from 'next/link';
import { organizationSummary } from '@devanalytics/api';
import { REQUIRED_GITHUB_EVENTS } from '@devanalytics/github';
import { PLANNED_PROVIDERS } from '@devanalytics/event-ingestion';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const session = await getSession();
  const runtime = await getRuntime();

  // These reads use the read/write role deliberately: the read-only analytics
  // role has no grant on credential tables, which is the point of that role.
  const summary = session.empty ? null : await organizationSummary(runtime.db, session.orgId);
  const endpoints = session.empty
    ? []
    : await runtime.db.withOrg(session.orgId, (sql) =>
        sql.many<{ id: string; provider: string; description: string; created_at: Date; revoked_at: Date | null; last_seen_at: Date | null }>(
          `select id, provider, description, created_at, revoked_at, last_seen_at from webhook_endpoints order by created_at desc`,
        ));
  const tokens = session.empty
    ? []
    : await runtime.db.withOrg(session.orgId, (sql) =>
        sql.many<{ id: string; name: string; token_prefix: string; role: string; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(
          `select id, name, token_prefix, role, created_at, last_used_at, revoked_at from api_tokens order by created_at desc`,
        ));

  return (
    <>
      <PageHeader
        title="Settings"
        description="Connections, credentials and deployment state."
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Organization</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs">
            {summary ? (
              <>
                <Row label="Name" value={summary.name} />
                <Row label="Slug" value={summary.slug} />
                <Row
                  label="Data source"
                  value={summary.is_demo ? 'Synthetic demo data' : 'Ingested provider events'}
                  tone={summary.is_demo ? 'warn' : 'good'}
                />
                <Row label="Repositories" value={String(summary.repositories)} />
                <Row label="Pull requests" value={Number(summary.pull_requests).toLocaleString('en-US')} />
                <Row label="Events" value={Number(summary.events).toLocaleString('en-US')} />
                <Row label="Last event" value={summary.last_event_at ? new Date(summary.last_event_at).toISOString().slice(0, 19).replace('T', ' ') : 'never'} />
              </>
            ) : (
              <p className="text-slate-400">
                No organization exists yet. Run <code className="text-slate-300">pnpm demo:seed</code> to load the demo
                organization, or connect a repository through the API.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Runtime</CardTitle></CardHeader>
          <CardContent className="flex flex-col gap-2 text-xs">
            <Row label="Database" value={runtime.config.databaseUrl ? 'Managed Postgres' : 'Embedded Postgres 16 (PGlite)'} />
            <Row label="Queue" value={runtime.config.redisUrl ? 'Redis with Postgres durability' : 'Postgres (durable)'} />
            <Row label="Auth mode" value={runtime.config.authMode} tone={runtime.config.authMode === 'local-dev' ? 'warn' : 'good'} />
            <Row
              label="AI narration"
              value={runtime.config.openRouterApiKey ? 'OpenRouter configured' : 'Not configured (answers assembled from evidence)'}
            />
            <Row label="Base URL" value={runtime.config.baseUrl} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Webhook endpoints</CardTitle>
            <p className="text-xs text-slate-500">
              Each endpoint has an unguessable id in its URL and a secret stored encrypted. The secret is shown once, at creation.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {endpoints.length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-400">
                No endpoints yet. Create one with the API, then subscribe to these GitHub events:{' '}
                <code className="text-slate-300">{REQUIRED_GITHUB_EVENTS.join(', ')}</code>.
              </p>
            ) : (
              <Table>
                <thead><tr><Th>Endpoint</Th><Th>Provider</Th><Th>Last seen</Th><Th>State</Th></tr></thead>
                <tbody>
                  {endpoints.map((e) => (
                    <tr key={e.id}>
                      <Td className="font-mono text-[11px]">{e.id.slice(0, 12)}…</Td>
                      <Td>{e.provider}</Td>
                      <Td className="font-mono text-[11px] text-slate-500">{e.last_seen_at ? new Date(e.last_seen_at).toISOString().slice(0, 16).replace('T', ' ') : 'never'}</Td>
                      <Td><Badge tone={e.revoked_at ? 'muted' : 'good'}>{e.revoked_at ? 'revoked' : 'active'}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API tokens</CardTitle>
            <p className="text-xs text-slate-500">
              Only a SHA-256 of each token is stored. Use a <code>viewer</code> token for the MCP server so the credential itself cannot write.
            </p>
          </CardHeader>
          <CardContent className="p-0">
            {tokens.length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-400">No tokens issued.</p>
            ) : (
              <Table>
                <thead><tr><Th>Name</Th><Th>Prefix</Th><Th>Role</Th><Th>Last used</Th><Th>State</Th></tr></thead>
                <tbody>
                  {tokens.map((t) => (
                    <tr key={t.id}>
                      <Td>{t.name}</Td>
                      <Td className="font-mono text-[11px] text-slate-500">dva_{t.token_prefix}_…</Td>
                      <Td><Badge tone={t.role === 'viewer' ? 'muted' : 'info'}>{t.role}</Badge></Td>
                      <Td className="font-mono text-[11px] text-slate-500">{t.last_used_at ? new Date(t.last_used_at).toISOString().slice(0, 16).replace('T', ' ') : 'never'}</Td>
                      <Td><Badge tone={t.revoked_at ? 'muted' : 'good'}>{t.revoked_at ? 'revoked' : 'active'}</Badge></Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Providers</CardTitle>
            <p className="text-xs text-slate-500">
              GitHub is implemented. The others have their event mappings written down and adapters stubbed; adding one touches
              nothing outside its adapter.
            </p>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/20 p-3">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-slate-100">GitHub</span>
                <Badge tone="good">implemented</Badge>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                Webhooks and REST backfill, HMAC-SHA256 signature verification over raw bytes.
              </p>
            </div>
            {PLANNED_PROVIDERS.map((p) => (
              <div key={p.provider} className="rounded-lg border border-slate-800 p-3">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-slate-100">{p.provider}</span>
                  <Badge tone="muted">planned</Badge>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">{p.signature}</p>
                <p className="mt-1.5 text-[11px] text-slate-500">
                  {Object.keys(p.events).length} native events mapped. {p.notes[0]}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 text-xs text-slate-500">
        API reference: <Link href="/api/v1/openapi.json" className="text-sky-400 hover:underline">OpenAPI document</Link> ·
        Metric contracts: <Link href="/metrics" className="text-sky-400 hover:underline">metric catalogue</Link>
      </p>
    </>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'warn' }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-900 pb-1.5 last:border-0">
      <span className="text-slate-500">{label}</span>
      {tone ? <Badge tone={tone}>{value}</Badge> : <span className="truncate text-right text-slate-300">{value}</span>}
    </div>
  );
}

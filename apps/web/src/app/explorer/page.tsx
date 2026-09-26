import Link from 'next/link';
import { CANONICAL_EVENT_TYPES } from '@devanalytics/core';
import { listEvents } from '@devanalytics/api';
import { Badge, Card, CardContent, CardHeader, CardTitle, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, type SearchParams } from '@/lib/filters';

export const dynamic = 'force-dynamic';

/**
 * Data explorer.
 *
 * The bottom of every drill-down. Shows the canonical events as ingested, with
 * their idempotency keys and processing state, so a number on a dashboard can be
 * traced to the provider delivery it came from.
 */
export default async function ExplorerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const sp = await searchParams;
  const filters = readFilters(sp);
  const type = typeof sp.type === 'string' ? sp.type : undefined;
  const runtime = await getRuntime();

  const events = (await listEvents(runtime.db, session.orgId, {
    ...(type ? { type } : {}),
    ...(filters.repositoryIds[0] ? { repoId: filters.repositoryIds[0] } : {}),
    limit: 100, offset: 0,
  })) as Record<string, unknown>[];

  const counts = await runtime.db.withOrg(session.orgId, (sql) =>
    sql.many<{ type: string; n: number; unprocessed: number }>(
      `select type, count(*)::int as n, count(*) filter (where processed_at is null)::int as unprocessed
         from events group by type order by n desc`,
    ), 'readonly');

  const deliveries = await runtime.db.unscoped((sql) =>
    sql.query<{ provider: string; signature_valid: boolean; http_status: number; n: number }>(
      `select provider, signature_valid, http_status, count(*)::int as n
         from webhook_deliveries group by 1,2,3 order by n desc limit 10`,
    ),
  );

  const queue = await runtime.db.unscoped((sql) =>
    sql.query<{ queue: string; pending: number; failed: number }>(
      `select queue,
              count(*) filter (where completed_at is null and attempts < max_attempts)::int as pending,
              count(*) filter (where attempts >= max_attempts and completed_at is null)::int as failed
         from job_queue group by 1 order by 1`,
    ),
  );

  return (
    <>
      <PageHeader
        title="Data explorer"
        description="The raw canonical events behind every metric, with their idempotency keys and processing state. Use this to verify that a number came from a real provider delivery."
        right={
          <Link href="/api/v1/openapi.json" className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800">
            OpenAPI
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader><CardTitle>Events by type</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead><tr><Th>Type</Th><Th className="text-right">Count</Th><Th className="text-right">Unprocessed</Th></tr></thead>
              <tbody>
                {counts.length === 0 && <tr><Td colSpan={3} className="text-center text-xs text-slate-400">No events ingested yet.</Td></tr>}
                {counts.map((c) => (
                  <tr key={c.type}>
                    <Td className="font-mono text-[11px]">
                      <Link href={`/explorer?type=${c.type}`} className="hover:text-sky-400">{c.type}</Link>
                    </Td>
                    <Td className="text-right tabular-nums">{Number(c.n).toLocaleString('en-US')}</Td>
                    <Td className="text-right tabular-nums">
                      {Number(c.unprocessed) > 0 ? <span className="text-amber-400">{c.unprocessed}</span> : <span className="text-slate-400">0</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Webhook deliveries</CardTitle>
            <p className="text-xs text-slate-400">Signature outcomes, for auditing.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead><tr><Th>Provider</Th><Th>Signature</Th><Th className="text-right">Status</Th><Th className="text-right">Count</Th></tr></thead>
              <tbody>
                {deliveries.rows.length === 0 && <tr><Td colSpan={4} className="text-center text-xs text-slate-400">No deliveries received yet.</Td></tr>}
                {deliveries.rows.map((d, i) => (
                  <tr key={i}>
                    <Td>{d.provider}</Td>
                    <Td><Badge tone={d.signature_valid ? 'good' : 'bad'}>{d.signature_valid ? 'valid' : 'rejected'}</Badge></Td>
                    <Td className="text-right tabular-nums">{d.http_status}</Td>
                    <Td className="text-right tabular-nums">{d.n}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Queue</CardTitle>
            <p className="text-xs text-slate-400">Work scheduled out of the request path.</p>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <thead><tr><Th>Queue</Th><Th className="text-right">Pending</Th><Th className="text-right">Exhausted</Th></tr></thead>
              <tbody>
                {queue.rows.length === 0 && <tr><Td colSpan={3} className="text-center text-xs text-slate-400">Queue is empty.</Td></tr>}
                {queue.rows.map((q) => (
                  <tr key={q.queue}>
                    <Td className="font-mono text-[11px]">{q.queue}</Td>
                    <Td className="text-right tabular-nums">{q.pending}</Td>
                    <Td className="text-right tabular-nums">
                      {Number(q.failed) > 0 ? <span className="text-rose-400">{q.failed}</span> : <span className="text-slate-400">0</span>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Events</CardTitle>
            <select
              defaultValue={type ?? ''}
              className="ml-auto rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
              disabled
              aria-label="Event type (use the links in the table above)"
            >
              <option value="">{type ?? 'all types'}</option>
              {CANONICAL_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {events.length === 0 ? (
            <p className="px-5 py-8 text-center text-xs text-slate-400">
              No events match. Events appear here as soon as a signed webhook is accepted.
            </p>
          ) : (
            <Table>
              <thead>
                <tr><Th>Type</Th><Th>Repository</Th><Th>Occurred</Th><Th>Received</Th><Th>Processed</Th><Th>Idempotency key</Th></tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={String(e.id)}>
                    <Td className="font-mono text-[11px]">{String(e.type)}</Td>
                    <Td className="text-slate-400">{e.full_name ? String(e.full_name) : '—'}</Td>
                    <Td className="font-mono text-[11px] text-slate-400">{new Date(String(e.occurred_at)).toISOString().slice(0, 19).replace('T', ' ')}</Td>
                    <Td className="font-mono text-[11px] text-slate-400">{new Date(String(e.received_at)).toISOString().slice(0, 19).replace('T', ' ')}</Td>
                    <Td>
                      {e.process_error ? (
                        <Badge tone="bad" title={String(e.process_error)}>failed</Badge>
                      ) : e.processed_at ? (
                        <Badge tone="good">applied</Badge>
                      ) : (
                        <Badge tone="warn">queued</Badge>
                      )}
                    </Td>
                    <Td className="max-w-40 truncate font-mono text-[10px] text-slate-400">{String(e.idempotency_key)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}

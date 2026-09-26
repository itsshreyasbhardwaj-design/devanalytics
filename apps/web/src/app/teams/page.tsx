import Link from 'next/link';
import { listTeams } from '@devanalytics/api';
import { formatMetric } from '@devanalytics/metrics';
import { INSUFFICIENT_DATA_LABEL } from '@devanalytics/core';
import { Card, CardContent, CardHeader, CardTitle, EmptyState, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { readFilters, filtersToQuery, type SearchParams } from '@/lib/filters';
import { describeWindow, loadMetric } from '@/lib/data';

export const dynamic = 'force-dynamic';

const TEAM_METRICS = ['pr_cycle_time', 'time_to_first_review', 'review_participation', 'build_success_rate', 'deployment_frequency'];

export default async function TeamsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const session = await getSession();
  if (session.empty) return <EmptyState title="No organization yet" description="Connect a repository under Settings." />;

  const filters = readFilters(await searchParams);
  const runtime = await getRuntime();
  const teams = await listTeams(runtime.db, session.orgId);

  const rows = [];
  for (const team of teams) {
    const metrics = [];
    for (const metric of TEAM_METRICS) {
      metrics.push(await loadMetric(session.orgId, metric, filters, { scopeType: 'team', scopeId: team.id }));
    }
    rows.push({ team, metrics });
  }
  const query = filtersToQuery(filters);

  return (
    <>
      <PageHeader
        title="Teams"
        description="Metrics aggregated by team, for finding process problems. There are no individual rankings anywhere in this product — see the note below."
        window={describeWindow(filters.window)}
      />

      {teams.length === 0 ? (
        <EmptyState
          title="No teams defined"
          description="Assign repositories to a team to aggregate metrics here. Without team information, use repository scope instead."
        />
      ) : (
        <Card className="mb-6">
          <CardContent className="p-0">
            <Table>
              <thead>
                <tr>
                  <Th>Team</Th><Th className="text-right">Repos</Th>
                  {TEAM_METRICS.map((m) => <Th key={m} className="text-right">{label(m)}</Th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ team, metrics }) => (
                  <tr key={team.id} className="hover:bg-slate-900/50">
                    <Td className="font-medium text-slate-100">{team.name}</Td>
                    <Td className="text-right tabular-nums text-slate-400">{team.repos}</Td>
                    {metrics.map((m) => (
                      <Td key={m.metric} className="text-right tabular-nums">
                        {m.value.result.status === 'ok' ? (
                          <Link href={`/metrics/${m.metric}?teamId=${team.id}&period=${filters.period}`} className="hover:text-sky-400">
                            {formatMetric(m.metric, m.value.result)}
                          </Link>
                        ) : (
                          <span className="text-[11px] text-slate-400">{INSUFFICIENT_DATA_LABEL}</span>
                        )}
                        <div className="text-[10px] text-slate-400">{m.value.result.sampleSize} obs</div>
                      </Td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Why there are no individual rankings</CardTitle></CardHeader>
        <CardContent className="text-xs leading-relaxed text-slate-400">
          <p className="mb-2">
            Engineering metrics measure a process, not a person. Cycle time depends on who was available to review, how large the
            change was, how long CI took and what else was in flight — almost none of which the author controls.
          </p>
          <p className="mb-2">
            Ranking individuals on these numbers reliably produces smaller pull requests, more of them, and reviewers who approve
            without reading. The metric improves; the engineering does not.
          </p>
          <p>
            Team and repository aggregation is available because those are the units that own a process and can change it. A signed-in
            user can see <Link href={`/metrics/pr_cycle_time${query}`} className="text-sky-400 hover:underline">their own</Link> activity,
            which is useful to them and to nobody else.
          </p>
        </CardContent>
      </Card>
    </>
  );
}

function label(metric: string): string {
  switch (metric) {
    case 'pr_cycle_time': return 'Cycle time';
    case 'time_to_first_review': return 'First review';
    case 'review_participation': return 'Reviewers/PR';
    case 'build_success_rate': return 'Build success';
    case 'deployment_frequency': return 'Deploys';
    default: return metric;
  }
}

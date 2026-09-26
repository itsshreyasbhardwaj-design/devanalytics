import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pullRequestDetail } from '@devanalytics/api';
import { Badge, Card, CardContent, CardHeader, CardTitle, Table, Td, Th } from '@devanalytics/ui';
import { PageHeader } from '@/components/page-header';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';

export const dynamic = 'force-dynamic';

const KIND_LABELS: Record<string, string> = {
  ready_for_review: 'Ready for review',
  commit: 'Commit',
  review: 'Review',
  review_comment: 'Comment',
  ci_run: 'CI run',
  merged: 'Merged',
  closed: 'Closed',
  deployment: 'Deployment',
};

const KIND_TONES: Record<string, 'neutral' | 'good' | 'bad' | 'warn' | 'info' | 'muted'> = {
  ready_for_review: 'info',
  commit: 'muted',
  review: 'neutral',
  review_comment: 'muted',
  ci_run: 'warn',
  merged: 'good',
  closed: 'muted',
  deployment: 'good',
};

export default async function PullRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (session.empty) notFound();

  const runtime = await getRuntime();
  let detail;
  try {
    detail = await pullRequestDetail(runtime.db, session.orgId, id);
  } catch {
    notFound();
  }
  const pr = detail.pullRequest;
  if (!pr) notFound();

  const fmt = (h: number | null) => (h === null ? 'not reached' : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);

  return (
    <>
      <PageHeader
        title={`${pr.repoFullName}#${pr.number}`}
        description={pr.title}
        right={
          <div className="flex items-center gap-2">
            <Badge tone={pr.state === 'merged' ? 'good' : pr.state === 'open' ? 'info' : 'muted'}>{pr.state}</Badge>
            {pr.reopenedCount > 0 && <Badge tone="warn">reopened {pr.reopenedCount}×</Badge>}
          </div>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Author" value={pr.authorLogin ?? 'unknown'} />
        <Stat label="Branch" value={`${pr.headBranch} → ${pr.baseBranch}`} />
        <Stat
          label="Lines changed"
          value={
            pr.additions === null || pr.deletions === null
              ? 'Not reported'
              : `+${pr.additions.toLocaleString('en-US')} / −${pr.deletions.toLocaleString('en-US')}`
          }
          hint={
            pr.additions === null
              ? 'This provider does not report diff statistics on its webhooks'
              : `${pr.changedFiles ?? '?'} files`
          }
        />
        <Stat label="Commits" value={String(pr.commitCount)} />
        <Stat label="Cycle time" value={fmt(detail.durations.cycleTimeHours)} hint="ready for review → merged" />
        <Stat label="Time to first review" value={fmt(detail.durations.timeToFirstReviewHours)} hint="ready for review → first review" />
        <Stat label="Merge after approval" value={fmt(detail.durations.mergeAfterApprovalHours)} hint="first approval → merged" />
        <Stat label="Reviewers" value={String(new Set(detail.reviewers.map((r) => r.login)).size)} hint={`${detail.reviewers.length} reviews`} />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Timeline</CardTitle>
          <p className="text-xs text-slate-400">
            Every ingested event for this pull request, in order. This is what the delivery metrics are computed from.
          </p>
        </CardHeader>
        <CardContent>
          <ol className="relative flex flex-col gap-0 border-l border-slate-800 pl-4">
            {detail.timeline.map((entry, i) => (
              <li key={`${entry.at}-${i}`} className="relative py-2">
                <span className="absolute -left-[21px] top-3.5 h-2 w-2 rounded-full bg-slate-600" aria-hidden />
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={KIND_TONES[entry.kind] ?? 'neutral'}>{KIND_LABELS[entry.kind] ?? entry.kind}</Badge>
                  <span className="text-sm text-slate-200">{entry.label}</span>
                  <time className="ml-auto font-mono text-[11px] text-slate-400" dateTime={entry.at}>
                    {entry.at.replace('T', ' ').slice(0, 19)}
                  </time>
                </div>
                {Object.entries(entry.detail).filter(([, v]) => v !== null && v !== undefined).length > 0 && (
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {Object.entries(entry.detail)
                      .filter(([, v]) => v !== null && v !== undefined)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Reviews</CardTitle></CardHeader>
          <CardContent className="p-0">
            {detail.reviewers.length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-400">
                No reviews recorded. This pull request contributes to review participation but not to time to first review.
              </p>
            ) : (
              <Table>
                <thead><tr><Th>Reviewer</Th><Th>State</Th><Th className="text-right">Submitted</Th></tr></thead>
                <tbody>
                  {detail.reviewers.map((r, i) => (
                    <tr key={i}>
                      <Td>{r.login ?? 'unknown'}</Td>
                      <Td><Badge tone={r.state === 'approved' ? 'good' : r.state === 'changes_requested' ? 'bad' : 'muted'}>{r.state.replace('_', ' ')}</Badge></Td>
                      <Td className="text-right font-mono text-[11px] text-slate-400">{r.submittedAt.replace('T', ' ').slice(0, 16)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>CI and deployments</CardTitle></CardHeader>
          <CardContent className="p-0">
            {detail.workflowRuns.length === 0 && detail.deployments.length === 0 ? (
              <p className="px-5 py-6 text-xs text-slate-400">No CI runs or deployments are linked to this pull request.</p>
            ) : (
              <Table>
                <thead><tr><Th>Item</Th><Th>Outcome</Th><Th className="text-right">Queue</Th><Th className="text-right">Duration</Th></tr></thead>
                <tbody>
                  {detail.workflowRuns.map((r) => (
                    <tr key={r.id}>
                      <Td>{r.name}</Td>
                      <Td><Badge tone={r.conclusion === 'success' ? 'good' : r.conclusion === 'failure' ? 'bad' : 'muted'}>{r.conclusion ?? 'running'}</Badge></Td>
                      <Td className="text-right tabular-nums">{r.queueMinutes === null ? '—' : `${r.queueMinutes} min`}</Td>
                      <Td className="text-right tabular-nums">{r.durationMinutes === null ? '—' : `${r.durationMinutes} min`}</Td>
                    </tr>
                  ))}
                  {detail.deployments.map((d) => (
                    <tr key={d.id}>
                      <Td>{d.environment}{d.isProduction && <Badge tone="info" className="ml-1">production</Badge>}</Td>
                      <Td><Badge tone={d.state === 'success' ? 'good' : d.state === 'failure' ? 'bad' : 'muted'}>{d.state}</Badge></Td>
                      <Td className="text-right text-slate-400">—</Td>
                      <Td className="text-right font-mono text-[11px] text-slate-400">{d.createdAt.slice(0, 16).replace('T', ' ')}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="mt-6 text-xs text-slate-400">
        <Link href="/explorer" className="text-sky-400 hover:underline">Data explorer</Link> shows the raw provider events behind this page.
      </p>
    </>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-0.5">
        <span className="text-[11px] uppercase tracking-wider text-slate-400">{label}</span>
        <span className="truncate text-sm font-semibold text-slate-100">{value}</span>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </CardContent>
    </Card>
  );
}

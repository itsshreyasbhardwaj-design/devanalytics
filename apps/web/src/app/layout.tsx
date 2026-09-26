import type { Metadata } from 'next';
import { Suspense } from 'react';
import Link from 'next/link';
import './globals.css';
import { METRIC_DEFINITIONS, METRIC_IDS } from '@devanalytics/metrics';
import { Badge } from '@devanalytics/ui';
import { Nav } from '@/components/nav';
import { GlobalFilters } from '@/components/global-filters';
import { CommandPalette, type PaletteItem } from '@/components/command-palette';
import { DemoBanner } from '@/components/demo-banner';
import { getSession } from '@/lib/session';
import { getRuntime } from '@/lib/runtime';
import { listOrgRepositories, listTeams } from '@devanalytics/api';

export const metadata: Metadata = {
  title: 'DevAnalytics',
  description: 'Engineering intelligence computed from real development events.',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  const runtime = await getRuntime();

  const repositories = session.empty ? [] : await listOrgRepositories(runtime.db, session.orgId);
  const teams = session.empty ? [] : await listTeams(runtime.db, session.orgId);

  const paletteItems: PaletteItem[] = [
    ...repositories.map((r) => ({ id: r.id, kind: 'repository' as const, label: r.fullName, hint: 'repository', href: `/repositories/${r.id}` })),
    ...METRIC_IDS.map((id) => ({
      id, kind: 'metric' as const,
      label: METRIC_DEFINITIONS[id]?.name ?? id,
      hint: 'metric', href: `/metrics/${id}`,
    })),
    { id: 'overview', kind: 'section', label: 'Overview', hint: 'section', href: '/' },
    { id: 'anomalies', kind: 'section', label: 'Anomalies', hint: 'section', href: '/anomalies' },
    { id: 'investigations', kind: 'section', label: 'Investigations', hint: 'section', href: '/investigations' },
    { id: 'ask', kind: 'section', label: 'Ask a question', hint: 'section', href: '/ask' },
    { id: 'explorer', kind: 'section', label: 'Data explorer', hint: 'section', href: '/explorer' },
  ];

  return (
    <html lang="en">
      <body className="min-h-screen">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:bg-sky-500 focus:px-3 focus:py-2 focus:text-sm focus:text-slate-950">
          Skip to content
        </a>

        <div className="flex min-h-screen">
          <aside className="hidden w-60 shrink-0 flex-col gap-4 border-r border-slate-800 bg-slate-950 px-3 py-4 lg:flex">
            <Link href="/" className="flex items-center gap-2 px-2.5">
              <span className="flex h-6 w-6 items-center justify-center rounded bg-sky-500 text-xs font-bold text-slate-950">D</span>
              <span className="text-sm font-semibold tracking-tight text-slate-100">DevAnalytics</span>
            </Link>

            {!session.empty && (
              <div className="px-2.5">
                <p className="truncate text-xs text-slate-400">{session.orgName}</p>
                {session.isDemo && <Badge tone="warn" className="mt-1">demo data</Badge>}
              </div>
            )}

            <Suspense fallback={null}>
              <Nav />
            </Suspense>

            <div className="mt-auto px-2.5 text-[11px] leading-relaxed text-slate-400">
              <p>Metrics are computed from ingested events. Periods below a metric’s minimum sample size report “Insufficient data”.</p>
            </div>
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            {session.isDemo && <DemoBanner orgName={session.orgName} />}
            {!session.empty && (
              <Suspense fallback={<div className="h-12 border-b border-slate-800" />}>
                <GlobalFilters
                  repositories={repositories.map((r) => ({ id: r.id, fullName: r.fullName }))}
                  teams={teams.map((t) => ({ id: t.id, name: t.name }))}
                />
              </Suspense>
            )}
            <main id="main" className="min-w-0 flex-1 px-6 py-6">
              {children}
            </main>
          </div>
        </div>

        <Suspense fallback={null}>
          <CommandPalette items={paletteItems} />
        </Suspense>
      </body>
    </html>
  );
}

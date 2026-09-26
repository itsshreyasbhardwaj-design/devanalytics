'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { Bot, Calendar, Filter, Rocket } from 'lucide-react';
import { Badge, cn } from '@devanalytics/ui';
import { PERIOD_LABELS } from '@/lib/periods';

/**
 * Global filters.
 *
 * Writes straight to the URL so every metric on the page recomputes from the
 * same parameters. There is no client-side filtering of already-fetched data,
 * which is how dashboards end up showing a chart and a summary that disagree.
 */
export function GlobalFilters({
  repositories,
  teams,
}: {
  repositories: { id: string; fullName: string }[];
  teams: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [pending, startTransition] = useTransition();

  const update = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const params = new URLSearchParams(search.toString());
      mutate(params);
      startTransition(() => router.push(`${pathname}?${params.toString()}`));
    },
    [router, pathname, search, startTransition],
  );

  const period = search.get('period') ?? '30d';
  const repositoryId = search.get('repositoryId') ?? '';
  const teamId = search.get('teamId') ?? '';
  const excludeBots = search.get('excludeBots') !== 'false';
  const productionOnly = search.get('productionOnly') !== 'false';

  return (
    <div
      className={cn('flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950/80 px-6 py-3', pending && 'opacity-60')}
      role="group"
      aria-label="Global filters"
    >
      <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-slate-400">
        <Filter className="h-3.5 w-3.5" aria-hidden /> Filters
      </span>

      <label className="flex items-center gap-1.5 text-xs text-slate-400">
        <Calendar className="h-3.5 w-3.5" aria-hidden />
        <span className="sr-only">Time period</span>
        <select
          value={period}
          onChange={(e) => update((p) => p.set('period', e.target.value))}
          className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        >
          {Object.entries(PERIOD_LABELS).map(([value, label]) => (
            <option key={value} value={value}>{label}</option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1.5 text-xs text-slate-400">
        <span className="sr-only">Repository</span>
        <select
          value={repositoryId}
          onChange={(e) => update((p) => (e.target.value ? p.set('repositoryId', e.target.value) : p.delete('repositoryId')))}
          className="max-w-56 rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
        >
          <option value="">All repositories</option>
          {repositories.map((r) => (
            <option key={r.id} value={r.id}>{r.fullName}</option>
          ))}
        </select>
      </label>

      {teams.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          <span className="sr-only">Team</span>
          <select
            value={teamId}
            onChange={(e) => update((p) => (e.target.value ? p.set('teamId', e.target.value) : p.delete('teamId')))}
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
          >
            <option value="">All teams</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        </label>
      )}

      <button
        type="button"
        onClick={() => update((p) => (excludeBots ? p.set('excludeBots', 'false') : p.delete('excludeBots')))}
        aria-pressed={excludeBots}
        title="Exclude pull requests and commits authored by bots"
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          excludeBots ? 'border-slate-700 bg-slate-800 text-slate-200' : 'border-slate-800 bg-slate-900 text-slate-400',
        )}
      >
        <Bot className="h-3.5 w-3.5" aria-hidden />
        {excludeBots ? 'Bots excluded' : 'Bots included'}
      </button>

      <button
        type="button"
        onClick={() => update((p) => (productionOnly ? p.set('productionOnly', 'false') : p.delete('productionOnly')))}
        aria-pressed={productionOnly}
        title="Restrict deployment metrics to production environments"
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors',
          productionOnly ? 'border-slate-700 bg-slate-800 text-slate-200' : 'border-slate-800 bg-slate-900 text-slate-400',
        )}
      >
        <Rocket className="h-3.5 w-3.5" aria-hidden />
        {productionOnly ? 'Production only' : 'All environments'}
      </button>

      <div className="ml-auto">
        <Badge tone="muted">Press ⌘K</Badge>
      </div>
    </div>
  );
}

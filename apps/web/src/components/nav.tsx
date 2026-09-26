'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import {
  Activity, AlertTriangle, BarChart3, Boxes, Database, GitPullRequest,
  MessageSquare, Rocket, Search, Settings, Users, Workflow,
} from 'lucide-react';
import { cn } from '@devanalytics/ui';

const SECTIONS: { href: string; label: string; icon: typeof Activity; hint: string }[] = [
  { href: '/', label: 'Overview', icon: BarChart3, hint: 'Delivery, review and CI at a glance' },
  { href: '/repositories', label: 'Repositories', icon: Boxes, hint: 'Per-repository health' },
  { href: '/teams', label: 'Teams', icon: Users, hint: 'Aggregated by team' },
  { href: '/pull-requests', label: 'Pull requests', icon: GitPullRequest, hint: 'Individual pull requests and timelines' },
  { href: '/ci', label: 'CI', icon: Workflow, hint: 'Build reliability, duration and queue time' },
  { href: '/deployments', label: 'Deployments', icon: Rocket, hint: 'Frequency, lead time and failures' },
  { href: '/anomalies', label: 'Anomalies', icon: AlertTriangle, hint: 'Statistically unusual movements' },
  { href: '/investigations', label: 'Investigations', icon: Search, hint: 'What accounts for a change' },
  { href: '/metrics', label: 'Metrics', icon: Activity, hint: 'Definitions and formulas' },
  { href: '/ask', label: 'Ask', icon: MessageSquare, hint: 'Questions answered from evidence' },
  { href: '/explorer', label: 'Data explorer', icon: Database, hint: 'Raw events and records' },
  { href: '/settings', label: 'Settings', icon: Settings, hint: 'Connections, tokens and demo data' },
];

export function Nav() {
  const pathname = usePathname();
  const search = useSearchParams();
  const query = search.toString();

  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {SECTIONS.map(({ href, label, icon: Icon, hint }) => {
        const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={query ? `${href}?${query}` : href}
            title={hint}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
              active ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200',
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Activity, AlertTriangle, ArrowRight, Boxes, GitPullRequest, Search as SearchIcon } from 'lucide-react';
import { cn } from '@devanalytics/ui';

/**
 * Command palette (Cmd/Ctrl + K).
 *
 * Search over repositories, metrics, pull requests and sections. Repository and
 * metric entries are seeded from the server so the common case needs no
 * network; pull requests are searched on demand against the API.
 */
export interface PaletteItem {
  id: string;
  kind: 'section' | 'repository' | 'metric' | 'pull_request' | 'anomaly';
  label: string;
  hint?: string;
  href: string;
}

const ICONS: Record<PaletteItem['kind'], typeof SearchIcon> = {
  section: ArrowRight,
  repository: Boxes,
  metric: Activity,
  pull_request: GitPullRequest,
  anomaly: AlertTriangle,
};

export function CommandPalette({ items }: { items: PaletteItem[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [remote, setRemote] = useState<PaletteItem[]>([]);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (open) {
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setQuery('');
      setRemote([]);
    }
  }, [open]);

  // Pull requests are too numerous to ship to the client, so they are searched
  // server-side once the query looks deliberate.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setRemote([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/palette?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!res.ok) return;
        const body = (await res.json()) as { items: PaletteItem[] };
        setRemote(body.items ?? []);
      } catch {
        // Aborted or offline: the local results still stand.
      }
    }, 150);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, query]);

  const results = useMemo(() => {
    const all = [...items, ...remote];
    const q = query.trim().toLowerCase();
    if (!q) return all.slice(0, 12);
    const scored = all
      .map((item) => {
        const label = item.label.toLowerCase();
        const idx = label.indexOf(q);
        if (idx === 0) return { item, score: 0 };
        if (idx > 0) return { item, score: 1 + idx / 100 };
        if (item.hint?.toLowerCase().includes(q)) return { item, score: 5 };
        return null;
      })
      .filter((x): x is { item: PaletteItem; score: number } => x !== null)
      .sort((a, b) => a.score - b.score);
    return scored.slice(0, 14).map((s) => s.item);
  }, [items, remote, query]);

  const go = useCallback(
    (item: PaletteItem | undefined) => {
      if (!item) return;
      setOpen(false);
      router.push(item.href);
    },
    [router],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-950/70 p-4 pt-[12vh] backdrop-blur-sm" onClick={() => setOpen(false)}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-slate-800 px-4">
          <SearchIcon className="h-4 w-4 text-slate-400" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, results.length - 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
              if (e.key === 'Enter') { e.preventDefault(); go(results[active]); }
            }}
            placeholder="Search repositories, metrics, pull requests…"
            aria-label="Search"
            className="h-12 w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-400 focus:outline-none"
          />
        </div>

        <ul role="listbox" aria-label="Results" className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-slate-400">
              Nothing matches “{query}”. Try a repository name, a metric, or a pull request number.
            </li>
          )}
          {results.map((item, i) => {
            const Icon = ICONS[item.kind];
            return (
              <li key={`${item.kind}:${item.id}`} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item)}
                  className={cn(
                    'flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
                    i === active ? 'bg-slate-800 text-slate-100' : 'text-slate-300',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
                  <span className="truncate">{item.label}</span>
                  {item.hint && <span className="ml-auto truncate text-[11px] text-slate-400">{item.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="flex items-center gap-3 border-t border-slate-800 px-4 py-2 text-[11px] text-slate-400">
          <span>↑↓ navigate</span><span>↵ open</span><span>esc close</span>
        </div>
      </div>
    </div>
  );
}

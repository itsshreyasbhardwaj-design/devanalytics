import { listPullRequests } from '@devanalytics/db';
import { getRuntime } from '@/lib/runtime';
import { getSession } from '@/lib/session';

/**
 * Command palette search.
 *
 * Pull requests are too numerous to ship to the browser, so the palette
 * searches them here. Results are scoped to the caller's organization by the
 * same session and row-level security path as every other read.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (session.empty) return Response.json({ items: [] });

  const q = new URL(request.url).searchParams.get('q')?.trim() ?? '';
  if (q.length < 2) return Response.json({ items: [] });

  const runtime = await getRuntime();
  const numeric = /^#?(\d+)$/.exec(q);

  const rows = await runtime.db.withOrg(
    session.orgId,
    async (sql) => {
      if (numeric?.[1]) {
        return sql.many<{ id: string; number: number; title: string; full_name: string }>(
          `select p.id, p.number, p.title, r.full_name
             from pull_requests p join repositories r on r.id = p.repo_id
            where p.number = $1 order by p.created_at desc limit 10`,
          [Number(numeric[1])],
        );
      }
      return sql.many<{ id: string; number: number; title: string; full_name: string }>(
        `select p.id, p.number, p.title, r.full_name
           from pull_requests p join repositories r on r.id = p.repo_id
          where p.title ilike $1 order by p.created_at desc limit 10`,
        [`%${q}%`],
      );
    },
    'readonly',
  );
  void listPullRequests;

  return Response.json({
    items: rows.map((r) => ({
      id: r.id,
      kind: 'pull_request',
      label: `${r.full_name}#${r.number} — ${r.title}`,
      hint: 'pull request',
      href: `/pull-requests/${r.id}`,
    })),
  });
}

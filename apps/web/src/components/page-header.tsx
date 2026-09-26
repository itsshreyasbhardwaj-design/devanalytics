import { Badge } from '@devanalytics/ui';

export function PageHeader({
  title,
  description,
  window,
  right,
}: {
  title: string;
  description: string;
  window?: string;
  right?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold tracking-tight text-slate-50">{title}</h1>
        <p className="mt-1 max-w-2xl text-xs leading-relaxed text-slate-400">{description}</p>
      </div>
      <div className="flex items-center gap-2">
        {window && <Badge tone="muted">{window}</Badge>}
        {right}
      </div>
    </header>
  );
}

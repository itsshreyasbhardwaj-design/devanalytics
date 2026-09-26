'use client';

import { CartesianGrid, Line, LineChart, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useMemo } from 'react';

/**
 * Metric history.
 *
 * Buckets with insufficient data are `null`, and the line breaks there rather
 * than connecting across. A connected line would assert a value for a period we
 * declined to measure — the one thing this product must not do. Those periods
 * are also shaded, so a gap reads as "not enough data" rather than "nothing
 * happened".
 */
export interface TrendPoint {
  bucketStart: string;
  value: number | null;
  sampleSize: number;
}

export function TrendChart({
  points,
  unitLabel,
  height = 220,
  color = '#38bdf8',
}: {
  points: TrendPoint[];
  unitLabel: string;
  height?: number;
  color?: string;
}) {
  const data = useMemo(
    () =>
      points.map((p) => ({
        bucket: p.bucketStart.slice(0, 10),
        value: p.value,
        sampleSize: p.sampleSize,
      })),
    [points],
  );

  const gaps = useMemo(() => {
    const ranges: { from: string; to: string }[] = [];
    let start: string | null = null;
    for (const p of data) {
      if (p.value === null && start === null) start = p.bucket;
      if (p.value !== null && start !== null) {
        ranges.push({ from: start, to: p.bucket });
        start = null;
      }
    }
    if (start !== null && data.length > 0) ranges.push({ from: start, to: data[data.length - 1]?.bucket as string });
    return ranges;
  }, [data]);

  const withValues = data.filter((d) => d.value !== null).length;

  if (data.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-lg border border-dashed border-slate-800 text-xs text-slate-400">
        No periods in this window.
      </div>
    );
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" vertical={false} />
          {gaps.map((g, i) => (
            <ReferenceArea key={i} x1={g.from} x2={g.to} fill="#1e293b" fillOpacity={0.45} />
          ))}
          <XAxis dataKey="bucket" stroke="#475569" fontSize={10} tickLine={false} axisLine={false} minTickGap={24} />
          <YAxis stroke="#475569" fontSize={10} tickLine={false} axisLine={false} width={44} />
          <Tooltip
            contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, fontSize: 12 }}
            labelStyle={{ color: '#94a3b8' }}
            formatter={(value: unknown, _name: unknown, entry: { payload?: { sampleSize?: number } }) =>
              value === null
                ? ['Insufficient data', `${entry.payload?.sampleSize ?? 0} observations`]
                : [`${Number(value).toFixed(2)} ${unitLabel}`, `${entry.payload?.sampleSize ?? 0} observations`]
            }
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={2}
            dot={{ r: 2, fill: color }}
            activeDot={{ r: 4 }}
            // The line must break at nulls, not interpolate over them.
            connectNulls={false}
          />
        </LineChart>
      </ResponsiveContainer>
      <p className="mt-1 px-1 text-[11px] text-slate-400">
        {withValues} of {data.length} periods have enough data to report.
        {withValues < data.length && ' Shaded periods are below the metric’s minimum sample size and are left blank rather than plotted as zero.'}
      </p>
    </div>
  );
}

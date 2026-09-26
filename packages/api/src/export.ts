import { INSUFFICIENT_DATA_LABEL, type MetricResult } from '@devanalytics/core';
import { formatMetric, requireMetricDefinition, type SeriesPoint } from '@devanalytics/metrics';
import type { InvestigationReport } from '@devanalytics/investigations';

/**
 * Exports.
 *
 * Exported data carries the same honesty guarantees as the dashboard: a period
 * with insufficient data is exported as the literal string "Insufficient data",
 * never as 0 or an empty cell, because a blank in a spreadsheet gets averaged.
 * Every export also carries its metric definition and window, so a file that
 * outlives the conversation is still interpretable.
 */

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  if (rows.length === 0) return '';
  const cols = columns ?? Object.keys(rows[0] as Record<string, unknown>);
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  return `${lines.join('\n')}\n`;
}

export interface SeriesExportInput {
  metric: string;
  scopeLabel: string;
  window: { from: string; to: string };
  granularity: string;
  points: SeriesPoint[];
  filtersApplied: Record<string, unknown>;
  isDemo: boolean;
}

export function seriesToCsv(input: SeriesExportInput): string {
  const def = requireMetricDefinition(input.metric);
  const header = [
    `# metric,${def.id}`,
    `# name,${def.name}`,
    `# unit,${def.unit}`,
    `# formula,"${def.formula.replace(/"/g, "'")}"`,
    `# scope,${input.scopeLabel}`,
    `# window,${input.window.from} to ${input.window.to}`,
    `# granularity,${input.granularity}`,
    `# minimum_sample_size,${def.minimumSampleSize}`,
    `# filters,"${JSON.stringify(input.filtersApplied).replace(/"/g, "'")}"`,
    input.isDemo ? '# DATA SOURCE,SYNTHETIC DEMO DATA - NOT REAL MEASUREMENTS' : '# data source,ingested provider events',
  ].join('\n');

  const rows = input.points.map((p) => ({
    bucket_start: p.bucketStart,
    value: p.result.status === 'ok' ? p.result.value : INSUFFICIENT_DATA_LABEL,
    formatted: formatMetric(input.metric, p.result),
    sample_size: p.result.sampleSize,
    numerator: p.numerator,
    denominator: p.denominator,
    status: p.result.status,
  }));
  return `${header}\n${toCsv(rows)}`;
}

export interface JsonExport {
  metric: { id: string; name: string; unit: string; formula: string; dataSource: string[]; minimumSampleSize: number; caveats: string[] };
  scope: string;
  window: { from: string; to: string };
  granularity: string;
  filters: Record<string, unknown>;
  dataSource: 'ingested' | 'synthetic_demo';
  points: { bucketStart: string; value: number | null; status: string; sampleSize: number; numerator: number | null; denominator: number | null }[];
  generatedAt: string;
}

export function seriesToJson(input: SeriesExportInput): JsonExport {
  const def = requireMetricDefinition(input.metric);
  return {
    metric: {
      id: def.id, name: def.name, unit: def.unit, formula: def.formula,
      dataSource: def.dataSource, minimumSampleSize: def.minimumSampleSize, caveats: def.caveats,
    },
    scope: input.scopeLabel,
    window: input.window,
    granularity: input.granularity,
    filters: input.filtersApplied,
    dataSource: input.isDemo ? 'synthetic_demo' : 'ingested',
    points: input.points.map((p) => ({
      bucketStart: p.bucketStart,
      value: p.result.status === 'ok' ? p.result.value : null,
      status: p.result.status,
      sampleSize: p.result.sampleSize,
      numerator: p.numerator,
      denominator: p.denominator,
    })),
    generatedAt: new Date().toISOString(),
  };
}

/** Investigation report as Markdown, suitable for pasting into an incident review. */
export function investigationToMarkdown(report: InvestigationReport, isDemo: boolean): string {
  const lines: string[] = [];
  if (isDemo) lines.push('> **Synthetic demo data.** These figures describe a generated organization, not real engineering activity.', '');
  lines.push(`# ${report.title}`, '');
  lines.push(`**Period**: ${report.window.from} to ${report.window.to}`);
  lines.push(`**Baseline**: ${report.baselineWindow.from} to ${report.baselineWindow.to}`, '');
  lines.push('## Summary', '', report.headline, '');

  if (report.decomposedOnMean) {
    lines.push(
      '> The headline figure is a median. Contribution figures below decompose the mean of the same observations, because a median delta cannot be decomposed exactly.',
      '',
    );
  }

  for (const dim of report.dimensions) {
    if (dim.contributors.length === 0) continue;
    lines.push(`## Contribution by ${dim.dimension}`, '');
    lines.push('| ' + dim.dimension + ' | Current | Baseline | Share of change | Own change | Volume shift | Observations |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of dim.contributors) {
      lines.push(
        `| ${c.label} | ${fmt(c.currentValue)} | ${fmt(c.baselineValue)} | ${(c.contributionShare * 100).toFixed(1)}% | ${c.rateEffect.toFixed(2)} | ${c.mixEffect.toFixed(2)} | ${c.sampleSize} |`,
      );
    }
    lines.push('', `_Residual after decomposition: ${dim.residual.toFixed(6)} (zero means the shares account for the entire measured change)._`, '');
  }

  if (report.related.length > 0) {
    lines.push('## Associated metrics', '', '_Observed over the same period. Association, not cause._', '');
    for (const r of report.related) lines.push(`- **${r.name}**: ${r.statement}`);
    lines.push('');
  }

  if (report.evidence.length > 0) {
    lines.push('## Records examined', '');
    for (const e of report.evidence) lines.push(`- ${e.label} — ${JSON.stringify(e.detail)}`);
    lines.push('');
  }

  lines.push('## How to read this', '');
  for (const c of report.caveats) lines.push(`- ${c}`);
  lines.push('', `_Generated ${new Date().toISOString()} by DevAnalytics._`);
  return lines.join('\n');
}

function fmt(v: number | null): string {
  return v === null ? INSUFFICIENT_DATA_LABEL : v.toFixed(2);
}

/**
 * Minimal PDF writer.
 *
 * A report PDF is a page of laid-out text, which the PDF format expresses
 * directly. Writing the ~60 lines of structure here avoids adding a rendering
 * dependency (and a headless browser) to the deployment for a feature that does
 * not need one. Output is a valid PDF 1.4 with correct xref offsets.
 */
export function textToPdf(title: string, body: string): Uint8Array {
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 48;
  const lineHeight = 13;
  const maxCharsPerLine = 92;
  const linesPerPage = Math.floor((pageHeight - margin * 2) / lineHeight) - 2;

  const wrapped: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\t/g, '    ');
    if (line.length <= maxCharsPerLine) { wrapped.push(line); continue; }
    let rest = line;
    while (rest.length > maxCharsPerLine) {
      let cut = rest.lastIndexOf(' ', maxCharsPerLine);
      if (cut <= 0) cut = maxCharsPerLine;
      wrapped.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) wrapped.push(rest);
  }

  const pages: string[][] = [];
  for (let i = 0; i < wrapped.length; i += linesPerPage) pages.push(wrapped.slice(i, i + linesPerPage));
  if (pages.length === 0) pages.push([]);

  const escape = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)').replace(/[^\x20-\x7e]/g, '?');

  const objects: string[] = [];
  const pageObjectNumbers: number[] = [];
  // 1 = catalog, 2 = pages, 3 = font, then per page: content, page
  const firstPageObj = 4;
  pages.forEach((_, i) => pageObjectNumbers.push(firstPageObj + i * 2 + 1));

  objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
  objects.push(`<< /Type /Pages /Kids [${pageObjectNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${pages.length} >>`);
  objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>`);

  pages.forEach((pageLines, pageIndex) => {
    const header = pageIndex === 0 ? [`${title}`, ''] : [];
    const all = [...header, ...pageLines];
    const text = all
      .map((line, i) => `BT /F1 ${pageIndex === 0 && i === 0 ? 13 : 9} Tf ${margin} ${pageHeight - margin - i * lineHeight} Td (${escape(line)}) Tj ET`)
      .join('\n');
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${firstPageObj + pageIndex * 2} 0 R >>`,
    );
  });

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return new TextEncoder().encode(pdf);
}

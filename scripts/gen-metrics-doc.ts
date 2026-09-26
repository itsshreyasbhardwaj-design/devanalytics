/** Generates METRICS.md from the metric registry, so documentation cannot drift from behaviour. */
import { writeFileSync } from 'node:fs';
import { METRIC_DEFINITIONS, METRIC_IDS, isAggregatable } from '@devanalytics/metrics';
import { FIXTURE_EXPECTATIONS } from '@devanalytics/demo-data';

const lines: string[] = [];

lines.push('# Metric definitions', '');
lines.push('<!-- GENERATED FILE. Run `pnpm docs:metrics` after changing packages/metrics/src/definitions.ts. -->', '');
lines.push(
  'Every metric DevAnalytics computes, with its exact formula, source tables, time anchor and minimum sample size.',
  'This file is generated from `packages/metrics/src/definitions.ts`, which is the same registry the engine, the API,',
  'the SDK, the MCP server and the AI layer read. A metric that is not here cannot be computed, charted or cited anywhere.',
  '',
);

lines.push('## Reading these definitions', '');
lines.push(
  '**Time anchor** is the column that places a record in a time bucket. It is stated explicitly because it is the most',
  'common source of disagreement between two tools reporting "the same" metric: a pull request opened in March and merged',
  'in April belongs to March for PR size and to April for cycle time.',
  '',
  '**Minimum sample size** is the number of observations required before a value is reported at all. Below it, the metric',
  'returns `insufficient_data` with the counts, and every surface renders the words "Insufficient data". No surface',
  'substitutes zero.',
  '',
  '**Aggregation** determines whether a window value can be rebuilt from daily snapshots. Medians cannot: the median of',
  'daily medians is not the median. Those metrics are recomputed from records and are marked below.',
  '',
  '**Windows** are half-open, `[from, to)`. That is what makes daily, weekly and monthly buckets tile the timeline exactly',
  'once, with no record counted twice and none dropped.',
  '',
);

lines.push('## Summary', '');
lines.push('| Metric | Unit | Direction | Aggregation | Min. sample | Time anchor |');
lines.push('| --- | --- | --- | --- | ---: | --- |');
for (const id of METRIC_IDS) {
  const d = METRIC_DEFINITIONS[id];
  if (!d) continue;
  lines.push(
    `| [${d.name}](#${id.replace(/_/g, '-')}) | ${d.unit} | ${d.direction.replace(/_/g, ' ')} | ${d.aggregation}${isAggregatable(d) ? '' : ' (not aggregatable)'} | ${d.minimumSampleSize} | \`${d.timeAnchor}\` |`,
  );
}
lines.push('');

for (const id of METRIC_IDS) {
  const d = METRIC_DEFINITIONS[id];
  if (!d) continue;
  lines.push(`## ${id.replace(/_/g, '-')}`, '');
  lines.push(`### ${d.name}`, '');
  lines.push(d.description, '');
  lines.push(`- **Id**: \`${d.id}\``);
  lines.push(`- **Formula**: ${d.formula}`);
  lines.push(`- **Data source**: ${d.dataSource.map((t) => `\`${t}\``).join(', ')}`);
  lines.push(`- **Unit**: ${d.unit}`);
  lines.push(`- **Time anchor**: \`${d.timeAnchor}\``);
  lines.push(`- **Aggregation**: ${d.aggregation}${isAggregatable(d) ? ' (window values can be rebuilt from daily snapshots)' : ' (recomputed from records; a median of medians would be wrong)'}`);
  lines.push(`- **Direction**: ${d.direction.replace(/_/g, ' ')}`);
  lines.push(`- **Minimum sample size**: ${d.minimumSampleSize} observations`);
  lines.push(`- **Supported scopes**: ${d.supportedScopes.join(', ')}`);
  lines.push(`- **Applicable filters**: ${d.appliedFilters.join(', ')}`);
  lines.push('');
  lines.push('**Caveats**', '');
  for (const c of d.caveats) lines.push(`- ${c}`);
  const expectation = FIXTURE_EXPECTATIONS[id];
  if (expectation) {
    lines.push('', '**Verified against the metric test dataset**', '');
    lines.push(
      expectation.status === 'ok'
        ? `Expected value \`${expectation.value}\` from ${expectation.sampleSize} observations. Derivation: ${expectation.derivation}`
        : `Expected \`insufficient_data\` with ${expectation.sampleSize} observations. Derivation: ${expectation.derivation}`,
    );
  }
  lines.push('');
}

lines.push('## Filters', '');
lines.push('| Filter | Default | Effect |');
lines.push('| --- | --- | --- |');
lines.push('| `repositoryIds` | all | Restrict to specific repositories. |');
lines.push('| `teamIds` | all | Restrict to repositories owned by specific teams. |');
lines.push('| `branches` | all | Restrict to specific branches (base branch for pull requests, head branch for CI runs). |');
lines.push('| `authorUserIds` | all | Restrict to specific authors. Available for personal views; never used to rank people. |');
lines.push('| `excludeBots` | `true` | Exclude bot-authored pull requests and commits. Dependency bots otherwise dominate throughput and size. |');
lines.push('| `productionOnly` | `true` | Restrict deployment metrics to production environments. |');
lines.push('');
lines.push(
  'Two numbers computed with different filters are not comparable. Every export embeds the filters that produced it, and',
  'the dashboard keeps them in the URL so a filtered view can be shared as a link.',
  '',
);

writeFileSync('METRICS.md', `${lines.join('\n')}\n`);
console.log(`wrote METRICS.md (${METRIC_IDS.length} metrics)`);

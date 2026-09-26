import { formatMetric, requireMetricDefinition } from '@devanalytics/metrics';
import type { EvidenceBundle, Citation } from './evidence.js';
import { containsCausalClaim, verifyGrounding, type GroundingResult } from './grounding.js';
import { DisabledLlmClient, type LlmClient } from './llm.js';

/**
 * Answering.
 *
 * The deterministic renderer is the product's actual answer: it is assembled
 * from the evidence bundle, so every sentence is traceable by construction.
 * A model, when one is configured, is used only to rewrite that material into
 * prose, and its output has to survive grounding verification — every figure
 * present in the evidence, no causal claims — or it is thrown away and the
 * deterministic answer is returned instead.
 */

export interface Answer {
  question: string;
  interpretation: string;
  /** Markdown. */
  answer: string;
  citations: Citation[];
  /** How the text was produced. Shown to the user. */
  generatedBy: 'deterministic' | 'model';
  model: string | null;
  grounding: GroundingResult;
  /** Set when a model answer was rejected, with the reason. */
  modelRejected: { reason: string; unsupported: number[] } | null;
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
  /** True when there was not enough data to answer at all. */
  insufficientData: boolean;
}

const SYSTEM_PROMPT = `You are a reporting assistant for an engineering analytics platform.

You will be given a question and a numbered list of VERIFIED FACTS computed from a database.

Rules, without exception:
1. Use only the facts provided. Never introduce a number, percentage, date, repository, team or person that does not appear in the facts.
2. Never state or imply that one thing caused another. The data is observational. Write "is associated with", "moved alongside", "accounts for N% of the change".
3. When the facts say data was insufficient, say that plainly. Do not estimate.
4. Cite facts inline as [F1], [F3] after the claim they support.
5. Be concise: a two-sentence summary, then short bullets. No preamble, no restating the question.`;

export class Explainer {
  constructor(private readonly llm: LlmClient = new DisabledLlmClient()) {}

  async explain(question: string, bundle: EvidenceBundle): Promise<Answer> {
    const deterministic = renderDeterministic(question, bundle);
    const insufficientData = isInsufficient(bundle);
    const baseGrounding = verifyGrounding(deterministic, bundle);

    const answer: Answer = {
      question,
      interpretation: bundle.plan.interpretation,
      answer: deterministic,
      citations: bundle.citations,
      generatedBy: 'deterministic',
      model: null,
      grounding: baseGrounding,
      modelRejected: null,
      confidence: bundle.plan.confidence,
      notes: bundle.notes,
      insufficientData,
    };

    if (!this.llm.available || bundle.empty) return answer;

    try {
      const prose = await this.llm.complete([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(question, bundle) },
      ]);
      const grounding = verifyGrounding(prose, bundle);
      if (!grounding.grounded) {
        return { ...answer, modelRejected: { reason: 'The generated text contained figures absent from the evidence.', unsupported: grounding.unsupported } };
      }
      if (containsCausalClaim(prose)) {
        return { ...answer, modelRejected: { reason: 'The generated text made a causal claim the data cannot support.', unsupported: [] } };
      }
      return { ...answer, answer: prose.trim(), generatedBy: 'model', model: this.llm.model, grounding };
    } catch (err) {
      return { ...answer, modelRejected: { reason: `Narration unavailable: ${(err as Error).message}`, unsupported: [] } };
    }
  }
}

function isInsufficient(bundle: EvidenceBundle): boolean {
  if (bundle.empty) return true;
  const primary = bundle.citations.find((c) => c.kind === 'metric');
  return Boolean(primary && primary.statement.includes('Insufficient data'));
}

function buildUserPrompt(question: string, bundle: EvidenceBundle): string {
  const facts = bundle.citations.map((c, i) => `[F${i + 1}] (${c.kind}, ${c.scope}) ${c.statement}`).join('\n');
  const notes = bundle.notes.length > 0 ? `\n\nCAVEATS that must be respected:\n${bundle.notes.map((n) => `- ${n}`).join('\n')}` : '';
  return `QUESTION: ${question}\n\nINTERPRETED AS: ${bundle.plan.interpretation}\n\nVERIFIED FACTS:\n${facts}${notes}`;
}

/** The answer of record: assembled directly from evidence, no model involved. */
export function renderDeterministic(question: string, bundle: EvidenceBundle): string {
  if (bundle.empty || !bundle.plan.metric) {
    return [
      `**Unable to answer.** ${bundle.notes[0] ?? 'The question could not be mapped to a metric this platform computes.'}`,
      '',
      'This platform answers questions about the metrics it actually measures. Ask about one of them, for example: "Why did PR cycle time increase?" or "What changed in build success rate over the last 30 days?"',
    ].join('\n');
  }

  const def = requireMetricDefinition(bundle.plan.metric);
  const cite = (kind: Citation['kind']) => bundle.citations.filter((c) => c.kind === kind);
  const lines: string[] = [];

  const metricCitation = cite('metric')[0];
  const comparison = cite('comparison')[0];

  lines.push(`### ${def.name} — ${bundle.plan.scopeHint ?? 'organization'}`);
  lines.push('');
  if (metricCitation) lines.push(metricCitation.statement);
  if (comparison) lines.push('', comparison.statement);

  const exclusions = cite('exclusion');
  if (exclusions.length > 0) {
    lines.push('', '**Excluded from this figure**');
    for (const e of exclusions) lines.push(`- ${e.statement}`);
  }

  const contributions = cite('contribution');
  if (contributions.length > 0) {
    lines.push('', '**What accounts for the change** (arithmetic decomposition of the measured delta)');
    for (const [i, c] of contributions.entries()) {
      lines.push(`- ${c.statement} [F${bundle.citations.indexOf(c) + 1}]`);
      void i;
    }
  }

  const correlations = cite('correlation');
  if (correlations.length > 0) {
    const moved = correlations.filter((c) => !/effectively unchanged/.test(c.statement));
    const flat = correlations.filter((c) => /effectively unchanged/.test(c.statement));
    if (moved.length > 0) {
      lines.push('', '**Associated metrics** (observed over the same period; association, not cause)');
      for (const c of moved) lines.push(`- ${c.statement} [F${bundle.citations.indexOf(c) + 1}]`);
    }
    if (flat.length > 0) {
      lines.push('', '**Checked and unchanged**');
      lines.push(`- ${flat.map((c) => c.metric).filter(Boolean).join(', ')}`);
    }
  }

  const records = cite('record');
  if (records.length > 0) {
    lines.push('', '**Underlying records**');
    for (const r of records) lines.push(`- ${r.statement}${r.href ? ` ([open](${r.href}))` : ''} [F${bundle.citations.indexOf(r) + 1}]`);
  }

  if (bundle.series.length > 0) {
    const withValues = bundle.series.filter((p) => p.value !== null);
    if (withValues.length > 0) {
      lines.push('', `**History**: ${withValues.length} periods with data out of ${bundle.series.length}.`);
      const insufficient = bundle.series.length - withValues.length;
      if (insufficient > 0) lines.push(`${insufficient} period(s) had too few observations to report and are shown as gaps, not as zero.`);
    }
  }

  if (bundle.notes.length > 0) {
    lines.push('', '**How to read this**');
    for (const n of bundle.notes.slice(0, 6)) lines.push(`- ${n}`);
  }

  lines.push('', `_Metric definition: ${def.formula}. Source: ${def.dataSource.join(', ')}. Time anchor: ${def.timeAnchor}._`);
  void question;
  void formatMetric;
  return lines.join('\n');
}

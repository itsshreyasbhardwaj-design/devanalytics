import type { EvidenceBundle } from './evidence.js';

/**
 * Grounding verification.
 *
 * Any narrative answer is checked number by number against the evidence that
 * was collected for it. A figure that does not appear in the evidence is not a
 * stylistic problem — it is a fabricated statistic — so an answer containing
 * one is discarded rather than shown with a disclaimer.
 *
 * This runs on every answer, including ones produced without a model, so the
 * deterministic renderer is held to the same standard.
 */

const NUMBER_RE = /-?\d+(?:[.,]\d+)?/g;

/**
 * Regions that carry identifiers rather than magnitudes.
 *
 * A pull request number, a row id inside a link, and a `[F3]` citation marker
 * are references, not claims about how large something is. They are masked out
 * before extraction so the check stays focused on the figures a reader would
 * act on — and so it cannot be satisfied by a model quoting an id.
 */
const IDENTIFIER_REGIONS: RegExp[] = [
  /\[F\d+\]/g,                    // citation markers
  /\]\([^)]*\)/g,                 // markdown link targets
  /\bhttps?:\/\/\S+/g,            // bare URLs
  /(?:^|\s)\/[\w\-/?=&.]+/g,       // app paths
  /#\d+/g,                        // pull request / issue numbers
  /\b[0-9a-f]{8,}\b/g,            // hex ids and shas
];

function maskIdentifiers(text: string): string {
  let out = text;
  for (const re of IDENTIFIER_REGIONS) out = out.replace(re, ' ');
  return out;
}

/** Figures that are not claims about the data. */
function isStructural(value: number, text: string, match: string): boolean {
  // Years, and the ISO dates the citations themselves contain.
  if (Number.isInteger(value) && value >= 1970 && value <= 2200) return true;
  // Part of an ISO timestamp or a date fragment.
  const idx = text.indexOf(match);
  if (idx > 0) {
    const around = text.slice(Math.max(0, idx - 11), idx + match.length + 11);
    if (/\d{4}-\d{2}-\d{2}/.test(around)) return true;
  }
  return false;
}

export interface GroundingResult {
  grounded: boolean;
  /** Numbers in the text with no supporting evidence. */
  unsupported: number[];
  checked: number;
}

export function verifyGrounding(text: string, bundle: EvidenceBundle, tolerance = 0.02): GroundingResult {
  const supported: number[] = bundle.citations.flatMap((c) => c.values).filter((v) => Number.isFinite(v));

  for (const c of bundle.citations) {
    // Sample sizes are always legitimate to quote.
    supported.push(c.sampleSize);
    // A citation's statement *is* the evidence, so every figure it contains is
    // supported by definition. Deriving the set from the statements as well as
    // from `values` means a citation that renders a ratio as a percentage, or
    // quotes a weight, does not have to remember to duplicate that number into
    // `values`. What remains unsupported is precisely what a narration made up.
    for (const match of maskIdentifiers(c.statement).match(NUMBER_RE) ?? []) {
      const n = Number(match.replace(',', '.'));
      if (Number.isFinite(n)) supported.push(n);
    }
  }
  for (const p of bundle.series) {
    if (p.value !== null) supported.push(p.value);
    supported.push(p.sampleSize);
  }

  // Caveats are quoted verbatim from the metric registry. "a flaky job that
  // passes on attempt 3" is definitional prose, not a measurement of this
  // dataset, and an answer repeating it has invented nothing.
  for (const note of bundle.notes) {
    for (const match of maskIdentifiers(note).match(NUMBER_RE) ?? []) {
      const n = Number(match.replace(',', '.'));
      if (Number.isFinite(n)) supported.push(n);
    }
  }

  const unsupported: number[] = [];
  let checked = 0;
  const scannable = maskIdentifiers(text);

  for (const match of scannable.match(NUMBER_RE) ?? []) {
    const value = Number(match.replace(',', '.'));
    if (!Number.isFinite(value)) continue;
    if (isStructural(value, scannable, match)) continue;
    checked++;
    const ok = supported.some((s) => {
      if (s === value) return true;
      const scale = Math.max(Math.abs(s), Math.abs(value), 1);
      if (Math.abs(s - value) / scale <= tolerance) return true;
      // Rounded restatements of the same figure.
      return Number(s.toFixed(1)) === Number(value.toFixed(1)) || Math.round(s) === Math.round(value);
    });
    if (!ok) unsupported.push(value);
  }

  return { grounded: unsupported.length === 0, unsupported, checked };
}

const CAUSAL_RE = /\b(caused|causes|causing|because of|due to|resulted in|led to|drove|responsible for|the reason (?:was|is))\b/i;

export function containsCausalClaim(text: string): boolean {
  return CAUSAL_RE.test(text);
}

import type { EvidenceHint } from '../../shared/types.ts';

/**
 * "from spec + branch" — one phrasing for every evidence-hint caption, so the visible copy, the
 * tooltips, and the two panels that wear hints (the cast row, the run row) cannot drift into
 * saying provenance three different ways.
 */
export function provenanceOf(hint: EvidenceHint): string {
  return `from ${hint.sources.join(' + ')}`;
}

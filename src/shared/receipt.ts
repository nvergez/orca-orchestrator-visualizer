import { parsePayload } from './payload.ts';
import type { ReceiptFact } from './types.ts';

/**
 * The outcome-receipt readers (#67, SPEC §14.4): what a task verifiably produced, read out of
 * the two columns that ever say — `tasks.result` and a `worker_done` message's `payload`.
 *
 * Both columns are TEXT holding whatever a worker or coordinator chose to write, with nothing
 * anywhere enforcing shape. So every reader here is a **shape check, never a cast** — the same
 * discipline as `parsePayload` beside it, extended from "does it parse" to "which of these
 * fields do I recognize". Three rules, each one a line the ticket draws:
 *
 * - **Never throw.** A value that cannot be read produces no facts. Not a lesser receipt, not
 *   a guess — nothing, and the raw value stays on screen where it always was. Unknown shapes
 *   are ordinary here, not schema drift: they never touch `meta.degraded` (SPEC §14.4).
 * - **Additive, top-level, allowlisted.** A fact comes from a top-level field whose *name* is
 *   recognized (below) or whose *value* is a valid URL. Nested objects, arrays of objects and
 *   prose are never mined — a reader that went hunting through arbitrary structure would be
 *   guessing, and the verbatim rendering already shows everything it would find.
 * - **Provider-neutral links.** A `link` is any string field whose value passes ordinary URL
 *   validation with an `http:`/`https:` scheme. No provider name appears in this file: a
 *   GitLab merge request and a Jira ticket are exactly as much a link as a GitHub PR (#67),
 *   and anything that is *not* a well-formed http(s) URL — `javascript:`, `ftp:`, a relative
 *   path — is never linkified.
 *
 * Shared, not server-only, for the reason `payload.ts` is: both ends of the wire interpret
 * the same evidence (the server summarizes turns and the detail route; the client renders
 * both), and two implementations of "what counts as a receipt fact" would drift — with the
 * row that fell between them being exactly the odd-shaped one this module is careful about.
 */

/** The two evidence sources, named as the columns they are — provenance strings start with one. */
export const RESULT_SOURCE = 'tasks.result';
export const WORKER_DONE_SOURCE = 'worker_done.payload';

/**
 * The field names this build recognizes, per kind. The list is an allowlist on purpose:
 * every name on it was seen in a real database (`filesModified`, `reportPath`, `completedBy`,
 * `branch`, `ticket`, `pr`) or is that name's obvious spelling variant. A field not on it is
 * not an error — it is simply left to the verbatim rendering.
 *
 * `link` is deliberately absent: a link is recognized by its *value* (a valid http(s) URL in
 * any field), never by its name — that is what keeps the model provider-neutral.
 */
const FIELDS: Record<Exclude<ReceiptFact['kind'], 'link'>, readonly string[]> = {
  branch: ['branch', 'branchName', 'branch_name'],
  ticket: ['ticket', 'ticketId', 'ticket_id', 'issue', 'pr'],
  agent: ['completedBy', 'completed_by', 'completingAgent', 'agent'],
  report: ['reportPath', 'report_path', 'report'],
  file: ['files', 'filesModified', 'files_modified', 'filesChanged', 'files_changed'],
};

/** Display order: the actionable outcome first, the (often long) file list last. */
const KIND_ORDER: readonly ReceiptFact['kind'][] = ['link', 'branch', 'ticket', 'agent', 'report', 'file'];

/**
 * A fact's identity: what deduplication keys on — here, in `mergeReceipts`, and in the list
 * the client renders. One implementation, because a fact deduplicated under one key and
 * rendered under another would collide exactly where the two drifted. A kind never contains
 * a space, so the pair reads back unambiguously.
 */
export function keyOf(fact: Pick<ReceiptFact, 'kind' | 'value'>): string {
  return `${fact.kind} ${fact.value}`;
}

/**
 * Read `tasks.result`. The column is a string; workers write JSON into it about half the
 * time and prose the other half. Prose is not scanned — recognized facts come from structure,
 * and the inspector shows the whole body verbatim either way.
 */
export function receiptOfResult(result: string | null): ReceiptFact[] {
  return factsOf(parsePayload(result), RESULT_SOURCE);
}

/** Read a `worker_done` message's already-parsed `payload` (`parsePayload`'s output). */
export function receiptOfWorkerDone(payload: unknown): ReceiptFact[] {
  return factsOf(payload, WORKER_DONE_SOURCE);
}

/**
 * Merge the readings of several sources into one presentation, without losing what makes them
 * several (#67): a value both sources stated is **one fact with both provenances**; a value
 * they disagree on is **two facts, both visible**. Deduplication is allowed exactly because
 * the provenance survives it — and order is deterministic (kind, then first appearance), so
 * two derivations of an unchanged database cannot render two different receipts.
 */
export function mergeReceipts(...readings: ReceiptFact[][]): ReceiptFact[] {
  const merged = new Map<string, ReceiptFact>();

  for (const fact of readings.flat()) {
    const key = keyOf(fact);
    const held = merged.get(key);

    if (held === undefined) {
      merged.set(key, { ...fact, sources: [...fact.sources] });
      continue;
    }

    for (const source of fact.sources) {
      if (!held.sources.includes(source)) held.sources.push(source);
    }
  }

  return sortByKind([...merged.values()]);
}

/**
 * The shape check itself. Only a plain object has fields to recognize; a scalar, an array or
 * an unparsed string answers with no facts and stays where it was — on screen, verbatim.
 */
function factsOf(value: unknown, source: string): ReceiptFact[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];

  const facts: ReceiptFact[] = [];
  const seen = new Set<string>();
  const add = (kind: ReceiptFact['kind'], raw: string, field: string): void => {
    const trimmed = raw.trim();
    // Within one source a repeated value is one fact — a list that names a file twice
    // produced it once. Across sources, `mergeReceipts` owns the same rule, under the same key.
    const key = keyOf({ kind, value: trimmed });
    if (trimmed === '' || seen.has(key)) return;
    seen.add(key);
    facts.push({ kind, value: trimmed, sources: [`${source} · ${field}`] });
  };

  for (const [field, held] of Object.entries(value)) {
    // A URL is a link whatever its field is called — checked first, so a `reportPath` that
    // holds `https://…` becomes a link rather than a path this machine was never promised.
    const url = typeof held === 'string' ? httpUrlOf(held) : null;
    if (url !== null) {
      add('link', url, field);
      continue;
    }

    const kind = kindOfField(field);
    if (kind === null) continue;

    if (kind === 'file') {
      // A file list is string entries only; anything else in it is skipped, not fatal —
      // refusing the whole list over one odd entry would cost the reader the other nine.
      if (Array.isArray(held)) {
        for (const entry of held) if (typeof entry === 'string') add('file', entry, field);
      } else if (typeof held === 'string') {
        add('file', held, field);
      }
      continue;
    }

    if (typeof held === 'string') add(kind, held, field);
    // Tickets are the one kind the real corpus writes as numbers: `{"ticket":68,"pr":79}`.
    else if (kind === 'ticket' && typeof held === 'number' && Number.isFinite(held)) add(kind, String(held), field);
  }

  return sortByKind(facts);
}

function kindOfField(field: string): Exclude<ReceiptFact['kind'], 'link'> | null {
  for (const [kind, names] of Object.entries(FIELDS)) {
    if (names.includes(field)) return kind as Exclude<ReceiptFact['kind'], 'link'>;
  }
  return null;
}

/**
 * Ordinary URL validation, then the two schemes and nothing else. `javascript:` is the one
 * this exists to stop — a receipt is untrusted text, and it must never become an `href` the
 * browser will execute.
 */
function httpUrlOf(value: string): string | null {
  const trimmed = value.trim();

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  return url.protocol === 'http:' || url.protocol === 'https:' ? trimmed : null;
}

/** Stable: kinds in display order, first appearance winning inside a kind. */
function sortByKind(facts: ReceiptFact[]): ReceiptFact[] {
  return facts
    .map((fact, index) => ({ fact, index }))
    .sort((a, b) => KIND_ORDER.indexOf(a.fact.kind) - KIND_ORDER.indexOf(b.fact.kind) || a.index - b.index)
    .map(({ fact }) => fact);
}

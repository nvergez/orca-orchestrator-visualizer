import type { Meta } from './types.ts';

/**
 * The sentences the spec writes for us, in one place.
 *
 * *"Orca isn't running; showing last-known state from &lt;time&gt;"* is not a phrasing
 * choice — it is the wording SPEC §6.1 and story 22 pin down, and it is the whole reason
 * the tool is allowed to render a four-day-old database without misleading anyone. The
 * terminal says it at boot and the page says it on screen; if the two are written twice
 * they drift, and one of them ends up lying.
 */

/** How the time is rendered: an ISO instant in the terminal, a local one in the browser. */
export type FormatTime = (iso: string) => string;

export function livenessSentence(
  { liveness, orcaPid, dbMtime }: Pick<Meta, 'liveness' | 'orcaPid' | 'dbMtime'>,
  formatTime: FormatTime = (iso) => iso
): string {
  // `unknown` — we could not read orca-runtime.json — degrades to exactly the stale wording
  // (SPEC §6.1). We do not know that Orca is running, so we do not say that it is.
  if (liveness !== 'live') {
    return `Orca isn't running; showing last-known state from ${formatTime(dbMtime)}`;
  }
  return `connected to a running Orca${orcaPid === null ? '' : ` (pid ${orcaPid})`}`;
}

/**
 * What this Orca's schema costs you — the banner (#21), and the same sentence in the terminal.
 *
 * Two sentences, and the difference between them is the whole of the degradation strategy.
 * A **newer** Orca is a *warning*: every column we know is still there, so everything renders,
 * and the only honest caveat is that a field it added — or renamed under us — may be showing up
 * missing or mislabeled. An **older** Orca is a *list*: it is missing columns we know by name,
 * so each one costs exactly the feature that needed it, and `meta.degraded` says which.
 *
 * Null when the schema is the one this build was written for, because a banner that is always
 * on screen is furniture, and furniture stops being read.
 */
export function schemaSentence({ schemaSupport, degraded }: Pick<Meta, 'schemaSupport' | 'degraded'>): string | null {
  if (schemaSupport === 'newer') {
    return 'This database is from a newer Orca schema — some data may be missing or mislabeled.';
  }
  // An older Orca that happens to be missing nothing we read is not a degraded one: there is
  // no feature to name, so there is nothing worth interrupting the user about.
  if (schemaSupport === 'older' && degraded.length > 0) {
    return 'This database is from an older Orca schema — these features are reduced:';
  }
  return null;
}

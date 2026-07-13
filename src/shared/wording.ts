import { ARCHIVE_VERSION, type ArchiveCompatibility, type ArchiveProvenance } from './archive.ts';
import type { HistoryLoss, Meta } from './types.ts';

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
 * One notice per lost history surface, in the order `Meta.historyLoss` already promises
 * (SPEC §5.1) — and in these exact words, spec'd like the liveness sentence above. Each
 * names the evidence first and then says the shape **matches** a reset: "matches" is
 * load-bearing, because the database proves the loss shape and never its cause (ADR 0003).
 * Rendered verbatim on both surfaces — backticks and all, like the `meta.degraded` entries —
 * because a paraphrase on either side is the drift this module exists to prevent.
 */
export const HISTORY_LOSS_SENTENCES: Record<HistoryLoss, string> = {
  'message-history':
    'Message history is incomplete: sequence gaps show that this database once held messages which are now missing. This matches an orchestration reset.',
  'task-graph-history':
    'Task graph history is missing: the graph is empty, but retained messages still refer to tasks. This matches `orchestration reset --tasks`.',
};

/**
 * What this Orca's schema costs you — the banner (#21), and the same sentence in the terminal.
 *
 * The heading is chosen by **what is actually missing**, never by the version number alone —
 * because the version number is a claim and the columns are the fact. Three cases:
 *
 * - A **newer** Orca is a *warning*. Every column we know is still there, so everything
 *   renders, and the only honest caveat is that a field it added — or renamed under us — may
 *   be showing up missing or mislabeled.
 * - An **older** Orca is a *list*: it is missing columns we know by name, so each one costs
 *   exactly the feature that needed it, and `meta.degraded` says which.
 * - A database at the version we read that is *still* missing a column — one Orca renamed, or
 *   a table it dropped — gets that same list. Gating the explanation on the version would
 *   leave precisely that user staring at a badge that never renders with nothing on screen to
 *   say why, which is the bug `meta.degraded` exists to prevent.
 *
 * Null when there is nothing to say, because a banner that is always on screen is furniture,
 * and furniture stops being read. An older Orca missing nothing we read is not a degraded one.
 */
export function schemaSentence({ schemaSupport, degraded }: Pick<Meta, 'schemaSupport' | 'degraded'>): string | null {
  if (schemaSupport === 'newer') {
    return 'This database is from a newer Orca schema — some data may be missing or mislabeled.';
  }
  if (degraded.length === 0) return null;

  return schemaSupport === 'older'
    ? 'This database is from an older Orca schema — these features are reduced:'
    : 'This Orca is missing columns this build expects — these features are reduced:';
}

/**
 * **What an archived replay is looking at** (#74) — and the sentence that has to be unmistakable,
 * because the thing it exists to prevent is somebody reading a saved file as current state.
 *
 * It says *archived*, it says *offline*, it says **when** the evidence was taken, and it makes no
 * claim about now — there is no process to be connected to, and nothing here is going to change.
 * The terminal prints it at boot and the page carries it in the bar it prints instead of the
 * liveness pill, out of this one function, for the same reason `livenessSentence` is one
 * function: two copies of a promise are two promises, and one of them eventually lies.
 */
export function archivedSentence(
  { exportedAt }: Pick<ArchiveProvenance, 'exportedAt'>,
  formatTime: FormatTime = (iso) => iso
): string {
  return `archived — an offline export taken on ${formatTime(exportedAt)}; nothing is running, and nothing here will change`;
}

/**
 * A file a *newer* orca-viz wrote, and this build opened anyway (#74).
 *
 * The evidence it recognizes is on screen; the fields it does not know are in the file, unread
 * and unaltered. Saying so is the whole of the compatibility contract: the alternative — showing
 * a partial archive silently — would be a post-mortem quietly missing an unknown amount of what
 * was exported. Null when the archive is one this build fully understands.
 */
export function archiveCompatibilitySentence(
  compatibility: ArchiveCompatibility,
  { version }: Pick<ArchiveProvenance, 'version'>
): string | null {
  if (compatibility !== 'newer') return null;

  return (
    `This archive was written by a newer orca-viz (archive format v${version}; this build reads ` +
    `v${ARCHIVE_VERSION}). Everything it recognizes is shown as it was written, and anything this ` +
    `version added is in the file but not on this screen — upgrade orca-viz to read it.`
  );
}

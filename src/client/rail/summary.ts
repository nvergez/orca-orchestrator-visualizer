/**
 * How a run reads on one line of the rail: `Jul 11, 20:54 · 8 tasks · 6 done / 1 failed`.
 *
 * The point of the line is to let the interesting run be picked *without opening it*
 * (SPEC §7.2) — so the breakdown leads with what went wrong and what got done, and a status
 * this build has never heard of is printed under its own name rather than silently dropped
 * from a tally the user is trusting to be complete.
 */

/** Done and failed first: on a four-day-old rail, those are what you are scanning for. */
const BREAKDOWN_ORDER = ['completed', 'failed', 'dispatched', 'ready', 'pending', 'blocked'];

/** The one status whose row word is not its schema name — "6 done" is what SPEC §7.2 writes. */
const WORDS: Record<string, string> = { completed: 'done' };

export function statusBreakdown(counts: Record<string, number>): string {
  const known = BREAKDOWN_ORDER.filter((status) => (counts[status] ?? 0) > 0);
  // An unknown status from a newer Orca still names real work (SPEC §5), so it is counted —
  // after the ones we understand, and in a stable order so the row does not shuffle on a tick.
  const unknown = Object.keys(counts)
    .filter((status) => !BREAKDOWN_ORDER.includes(status) && (counts[status] ?? 0) > 0)
    .sort();

  return [...known, ...unknown].map((status) => `${counts[status]} ${WORDS[status] ?? status}`).join(' / ');
}

/** `Jul 11, 20:54` — in the reader's own timezone, from the ISO instant the server sends. */
export function formatRunDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;

  return at.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

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

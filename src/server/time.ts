/**
 * The timestamp split, normalized away at the server boundary (SPEC §4.2, trap 5).
 *
 * Orca writes its timestamps two ways. Columns it fills from SQL (`datetime('now')`) hold
 * `'YYYY-MM-DD HH:MM:SS'` **in UTC**; the two it fills from JS — `tasks.completed_at` and
 * `coordinator_runs.completed_at` — hold ISO-8601. Both formats therefore appear on a
 * single row, and comparing them unnormalized silently produces garbage.
 *
 * The trap is sharper than it looks. `new Date('2026-07-08 12:32:13')` is parsed by JS as a
 * **local** time, so west of UTC a naively-read `created_at` lands *hours in the future* —
 * far enough to overtake the ISO `completed_at` on the same row and report a task that
 * finished before it started. The `Z` this module appends is the entire defence.
 *
 * The client never sees any of this: it is given ISO-8601 UTC instants, and only those.
 */

/** `'2026-07-08 12:32:13'` — optionally with fractional seconds, as SQLite may write. */
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/**
 * A timestamp column, as an ISO-8601 UTC instant — or null when the column is empty.
 *
 * A value in neither format is passed through verbatim, on the same principle as an unknown
 * task status (SPEC §5): the tool shows you what the database actually holds rather than
 * dropping the row or inventing an instant it cannot support.
 */
export function isoInstant(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;

  const raw = value.trim();
  // The SQL format carries no zone, and Orca writes it in UTC. Saying so is the fix.
  const parsed = new Date(SQL_TIME.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);

  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString();
}

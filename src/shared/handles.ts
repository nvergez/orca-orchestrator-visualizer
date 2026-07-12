/**
 * Orca's terminal handles are `term_<uuid>` — long enough that a rail row or a node badge
 * cannot show one, and the *only* identity an agent has anywhere in this schema.
 *
 * The first 8 hex are enough to recognise a terminal and to tell two apart, so they are what
 * the node badge shows, what the run label falls back to, and what the run id is built from.
 * The full handle is never thrown away: it lives on `Run.handle` and in the rail's tooltip.
 *
 * Shared, because the server derives run ids from it and the client renders badges from it,
 * and two implementations of "the short handle" would be one too many.
 */

/** `term_9f8e7d6c-1234-…` → `9f8e7d6c` (SPEC §7.5). */
export function shortHandle(handle: string): string {
  return handle.replace(/^term_/, '').slice(0, 8);
}

import type { Run } from './types.ts';

/**
 * Run health — a run's relationship to convergence and the recency of its last activity
 * (SPEC §12.3, CONTEXT.md).
 *
 * It is derived, never serialized: a server-computed value would freeze behind the
 * `data_version` no-push gate the moment the database went quiet — precisely the moment
 * `active` has to give way to `silent`. So the client derives it against its own wall clock
 * (`relative-time.ts`), and the server calls the same function once, at snapshot time, to
 * project the deprecated `live` flag (SPEC §12.4). One helper, so the two cannot disagree.
 *
 * What it says is evidence, not diagnosis. `active` means recorded work is recent; it does not
 * claim a terminal is alive. `silent` means an unfinished run has no recent evidence; it does
 * not call anything dead, stuck or hung. Whether the Orca *process* runs is `Meta.liveness`,
 * shown separately and never folded into this (SPEC §12.1).
 */

export type RunHealth = 'active' | 'silent' | 'finished';

/**
 * The canonical recency threshold: how quiet the evidence has to go before "recent" stops
 * being true.
 *
 * 2× the 5-minute heartbeat cadence Orca instructs its workers to keep — one missed beat is
 * noise, two is a worker that has stopped talking. The same constant turns an agent's
 * "last seen" badge amber (#47) and moves a run from `active` to `silent` (SPEC §12.3):
 * both are the one question "is this recent?", and a second threshold would be a second
 * answer to it.
 */
export const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

/**
 * The three states, from the two server-derived facts and a wall-clock `now`.
 *
 * Convergence always wins: a finished run is finished however fresh its last activity, because
 * finished is a fact about task outcomes and not about the clock. After that the boundary is
 * exact — younger than ten minutes is `active`, ten minutes on the dot (or unreadable) is
 * `silent`. Future evidence is clamped to age zero so modest clock skew stays `active` rather
 * than minting a fourth state (SPEC §12.3).
 */
export function runHealth(run: Pick<Run, 'converged' | 'lastActivityAt'>, now: number): RunHealth {
  if (run.converged) return 'finished';

  const at = Date.parse(run.lastActivityAt);
  if (Number.isNaN(at)) return 'silent';

  return Math.max(0, now - at) < STALE_HEARTBEAT_MS ? 'active' : 'silent';
}

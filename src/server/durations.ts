import type { Dispatch, DispatchStatus, DurationClock, DurationObservation, Task } from '../shared/types.ts';
import { instantOf } from './time.ts';

/**
 * Honest durations (#66, SPEC §12.4). A duration observation carries its **clock** — which
 * retained columns it read — beside the number, because "25 minutes" is three different facts
 * depending on whether it measured the worker's attempt, the task's whole lifetime, or the
 * run's occupancy of the calendar. The clocks, in order of preference:
 *
 * 1. **`dispatch`** — one attempt's own `dispatched_at → completed_at`. The worker's clock.
 * 2. **`task-span`** — `tasks.created_at → completed_at`. A visibly labelled fallback for a
 *    completed task whose dispatch clock never closed; it includes setup and queue time, and
 *    the label is what keeps it from being mistaken for dispatch time.
 * 3. **`run-span`** — earliest readable task creation to latest readable activity. Wall-clock
 *    occupancy of one orchestrator run, never summed agent time.
 *
 * And one rule over all of them: **a bad endpoint produces no observation.** A missing,
 * unreadable, negative or contradictory pair of instants is rendered *unknown* — never zero,
 * never the epoch, never a negative interval. `isoInstant` (`time.ts`) passes an unparseable
 * column through verbatim so the row survives; this module is where that honesty pays off,
 * because `instantOf` reads the garbage back as null and the observation simply is not made.
 *
 * The module is pure — normalized values in, observations out, no SQLite — which is what makes
 * its dense error surface testable value by value (SPEC §12.5).
 */

/** The one dispatch status that says an attempt is still running (HANDOFF.md enums). */
const IN_FLIGHT_DISPATCH: DispatchStatus = 'dispatched';

/**
 * A closed interval, when both endpoints can carry it: readable, and in order. `ms` is derived
 * from the same two instants it travels with, so the wire can never disagree with itself.
 *
 * Exported because the scoreboard's clocks are the same clocks (#68): an agent span and a time
 * to first heartbeat are intervals with the same rules, and a second module deciding for itself
 * what a backwards or unreadable endpoint means would be a second definition of honesty — one
 * that could drift from this one.
 */
export function closed(clock: DurationClock, startAt: string, endAt: string): DurationObservation | undefined {
  const start = instantOf(startAt);
  const end = instantOf(endAt);

  // Unreadable, or backwards. A negative interval is a contradiction in the retained evidence
  // (two writers, two clocks, or an overwrite) — not a duration anybody experienced.
  if (start === null || end === null || end < start) return undefined;

  return { clock, startAt, endAt, complete: true, ms: end - start };
}

/** An open interval: a readable start, and a client that will age it as "so far". */
export function open(clock: DurationClock, startAt: string): DurationObservation | undefined {
  return instantOf(startAt) === null ? undefined : { clock, startAt, complete: false };
}

/**
 * The earliest — or latest — readable instant among some strings, kept beside the string it was
 * read from. Unreadable values are *read past*, exactly as the run span reads past them: a
 * garbage-stamped row neither dates the interval nor mints a 1970 ghost.
 *
 * Shared with the scoreboard (#68), which asks this question three times over — the first
 * dispatch of an agent, its latest completion, its earliest heartbeat — and would otherwise
 * spell the same scan three more times.
 */
export function earliest(instants: readonly (string | null)[]): string | null {
  return pick(instants, (candidate, held) => candidate < held);
}

export function latest(instants: readonly (string | null)[]): string | null {
  return pick(instants, (candidate, held) => candidate > held);
}

function pick(instants: readonly (string | null)[], wins: (candidate: number, held: number) => boolean): string | null {
  let held: Reading | null = null;

  for (const iso of instants) {
    const at = instantOf(iso);
    if (at !== null && (held === null || wins(at, held.at))) held = { at, iso: iso! };
  }

  return held?.iso ?? null;
}

/**
 * One attempt's own clock — both endpoints from the **same** `dispatch_contexts` row, never a
 * start from one attempt against an end from another (SPEC §12.4).
 *
 * An attempt with no `completed_at` is *open* only while its status says the worker is still
 * out there. A terminal status with no end instant — and a status this build cannot read at
 * all — makes the observation absent: "so far" on work that already stopped would be a clock
 * ticking against nobody.
 */
export function dispatchDuration(
  attempt: Pick<Dispatch, 'status' | 'dispatchedAt' | 'completedAt'>
): DurationObservation | undefined {
  if (attempt.completedAt === null) {
    return attempt.status === IN_FLIGHT_DISPATCH ? open('dispatch', attempt.dispatchedAt) : undefined;
  }

  return closed('dispatch', attempt.dispatchedAt, attempt.completedAt);
}

/**
 * The task's own clock, on the strongest evidence it retains — and the preference order is the
 * feature (SPEC §12.4, stories 2–4):
 *
 * 1. The **latest attempt's completed dispatch clock**. The latest attempt is the one the node
 *    badge shows (`MAX(rowid)`, `tasks.ts`); an earlier attempt's clock measures a retry that
 *    failed, and the inspector's attempt history is where that story lives.
 * 2. A completed task with no such clock falls back to its **task span** — visibly labelled,
 *    because created → completed includes setup and queue time.
 * 3. A task with **no completion evidence at all** stays open on the attempt's clock, if one is
 *    running. The moment `completed_at` appears — readable or not — the open interval stops:
 *    "so far" on a task the file says finished would be a clock ticking against nobody. If the
 *    recorded end is unreadable, the honest observation is none.
 */
export function taskDuration(
  task: Pick<Task, 'createdAt' | 'completedAt' | 'dispatch'>
): DurationObservation | undefined {
  const attempt = task.dispatch === null ? undefined : dispatchDuration(task.dispatch);
  if (attempt?.complete) return attempt;

  if (task.completedAt !== null) return closed('task-span', task.createdAt, task.completedAt);

  return attempt;
}

/** An instant, kept beside the string it was read from — provenance survives the arithmetic. */
type Reading = { at: number; iso: string };

/**
 * The run's wall-clock span: earliest **readable** task creation to latest **readable**
 * completion/creation (SPEC §12.4). It measures how long the orchestration occupied the
 * calendar — never summed agent time, never compute time.
 *
 * Open while the run is **unfinished** — `!converged`, the same fact run health reads (`runs.ts`,
 * SPEC §12.3), and deliberately *not* the deprecated `live` boolean. Whether Orca happens to be
 * running is a fact about the reader's moment, not about the run: keying the span on it would
 * close a span retroactively when the user quit Orca, over an orchestration that never finished.
 * A run whose tasks all reached a terminal outcome has an end; one whose tasks did not is still
 * open, and the client ages it as "so far" — which is what `silent` says out loud.
 *
 * Unreadable instants are read past, exactly as the waves read past them: a garbage-stamped
 * task neither dates the run nor mints a 1970 ghost. No readable creation at all ⇒ no span.
 */
export function runSpan(
  tasks: readonly Pick<Task, 'createdAt' | 'completedAt'>[],
  unfinished: boolean
): DurationObservation | undefined {
  let start: Reading | null = null;
  let end: Reading | null = null;

  for (const task of tasks) {
    const created = read(task.createdAt);
    if (created !== null) {
      if (start === null || created.at < start.at) start = created;
      if (end === null || created.at > end.at) end = created;
    }

    const completed = read(task.completedAt);
    if (completed !== null && (end === null || completed.at > end.at)) end = completed;
  }

  // "Earliest readable task *creation*": completions alone cannot open a span — an end with no
  // beginning measures nothing.
  if (start === null) return undefined;

  if (unfinished) return { clock: 'run-span', startAt: start.iso, complete: false };

  // `end` exists whenever `start` does: the creation that set `start` was offered to `end` too.
  return { clock: 'run-span', startAt: start.iso, endAt: end!.iso, complete: true, ms: end!.at - start.at };
}

function read(iso: string | null): Reading | null {
  const at = instantOf(iso);
  return at === null ? null : { at, iso: iso! };
}

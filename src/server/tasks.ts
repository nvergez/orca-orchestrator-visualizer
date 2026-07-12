import type { DatabaseSync } from 'node:sqlite';
import type { Dispatch, Task } from '../shared/types.ts';
import { dispatchDuration, taskDuration } from './durations.ts';
import { type Columns, type Row, selectPresent, text } from './rows.ts';
import type { TaskWithHandle } from './runs.ts';
import { byInstant, isoInstant } from './time.ts';

/**
 * The DAG, read out of `tasks` and `dispatch_contexts`.
 *
 * Four things this owes the rest of the server, none of which they can work out for themselves:
 *
 * 1. **The bodies are omitted.** `spec` and `result` become `hasSpec` / `hasResult` — a live
 *    71-task dump was 172 KB, almost entirely spec text (SPEC §6.3). `GET /api/task/:id`
 *    fetches them on click (#20).
 * 2. **The latest dispatch attempt is `MAX(rowid)`**, as Orca's own queries have it — never
 *    the latest `dispatched_at`, which a retry can order backwards. `attemptCount` counts
 *    them all, and it is the *only* visible sign anywhere in this schema that a task was
 *    retried (SPEC §7.5).
 * 3. **Every timestamp is an ISO-8601 UTC instant** (`time.ts`).
 * 4. **The run key travels beside the task, not on it.** `created_by_terminal_handle` is what
 *    runs are inferred from (`runs.ts`) and it is not part of the wire contract — a run's
 *    handle belongs to the *run*. So the reader hands it over rather than smuggling it onto
 *    the task or making the inference re-open the database to find it.
 *
 * Every query is built from the columns the database really has (`schema.ts`), so an older
 * Orca costs exactly the badge whose column is missing — never the graph.
 */

/** Read if present. `tasks.id` / `status` / `deps` are the DAG core and always are. */
const TASK_COLUMNS = [
  'id',
  'parent_id',
  'created_by_terminal_handle',
  'task_title',
  'display_name',
  'spec',
  'status',
  'deps',
  'result',
  'created_at',
  'completed_at',
] as const;

/**
 * How much of a body the conversation gets. The rest of it stays in the file.
 *
 * The conversation needs `tasks.spec` — it is the *only* record of what the orchestrator told an
 * agent to do, because no `dispatch` message is ever written (SPEC §4.2, trap 2). But a live
 * 71-task dump was 172 KB, almost entirely spec text, and the snapshot is re-sent whole on every
 * push (SPEC §6.3). Both of those are true at once, and a preview is what they add up to: a
 * bubble in a 400px dock was never going to show 3 KB of agent prompt, and the node inspector is
 * one click away with the whole of it.
 */
export const BODY_PREVIEW_CHARS = 240;

/**
 * The bodies never cross the SQLite boundary in the first place.
 *
 * `substr` is what keeps that true now that the conversation wants the beginning of a spec:
 * SQLite slices the column and hands over 240 characters, and the other 3 KB of agent prompt
 * stays in the file. Reading the whole thing into the process to slice it here would be the
 * same waste the snapshot exists to avoid (SPEC §6.3).
 *
 * One character *past* the cap, so that "was there more?" is a fact about the string we hold
 * rather than a guess: a preview longer than the cap is a body that was cut.
 */
const BODY_PREVIEW: Record<string, string> = {
  spec: `substr(spec, 1, ${BODY_PREVIEW_CHARS + 1}) AS spec`,
  result: `substr(result, 1, ${BODY_PREVIEW_CHARS + 1}) AS result`,
};

/**
 * Exported for `task-detail.ts`, which reads the same rows for one task and keeps **all** of
 * them (#20). One column list and one row → `Dispatch` mapping, because the snapshot's latest
 * attempt and the inspector's attempt history are the same row read twice — and two readings
 * of it would drift into two different stories about the same retry.
 */
export const DISPATCH_COLUMNS = [
  'id',
  'task_id',
  'assignee_handle',
  'status',
  'failure_count',
  'last_failure',
  'dispatched_at',
  'completed_at',
  'created_at',
  'last_heartbeat_at',
] as const;

/**
 * Every task in the database, in creation order, each with the handle that created it.
 *
 * `runId` is left empty here: it is not a column, it is a *guess*, and the guess is made in
 * one place (`runs.ts`) over the whole task set at once.
 */
export function readTasks(db: DatabaseSync, columns: Columns): TaskWithHandle[] {
  const attempts = readAttempts(db, columns);

  return selectPresent(db, 'tasks', columns.tasks, TASK_COLUMNS, BODY_PREVIEW)
    .map((row): TaskWithHandle => {
      const id = text(row.id) ?? '';
      const held = attempts.get(id) ?? [];
      const latest = held[held.length - 1] ?? null;
      // Pre-v5 Orca named neither. A *task* then falls back to its short id; a *run* falls
      // back to its handle — so the name is passed on unresolved, and each falls back its own way.
      const name = text(row.task_title) ?? text(row.display_name);

      // `hasSpec` used to be a SQL predicate and is now the same question asked of the preview:
      // a non-empty slice of a column is a non-empty column, and an absent one slices to null.
      const spec = text(row.spec);
      const result = text(row.result);

      const task: Task = {
        id,
        // Filled by `inferRuns` — the schema has no run id, so nothing here can read one.
        runId: '',
        // Filled by `attachGates` — from the `decision_gate` *messages* that raise a gate,
        // never from the `decision_gates` table, which is empty on every real database
        // (SPEC §4.2, trap 1). Nothing about a task row says it is blocked.
        gate: null,
        parentId: text(row.parent_id),
        title: name ?? shortId(id),
        // Verbatim: a status this tool has never heard of still names a real state, and a
        // task missing from the graph is a worse lie than a task in an odd colour (SPEC §5).
        status: text(row.status) ?? '',
        deps: parseDeps(row.deps),
        createdAt: isoInstant(row.created_at) ?? '',
        completedAt: isoInstant(row.completed_at),
        hasSpec: spec !== null,
        hasResult: result !== null,
        dispatch: latest,
        attemptCount: held.length,
      };

      // Absent when the retained endpoints support no number — never zero, never the epoch (#66).
      const duration = taskDuration(task);
      if (duration !== undefined) task.duration = duration;

      return {
        // Absent before schema v4, and null on 4 of 76 live tasks even now: both land the
        // task in the one synthetic `run_unattributed` rather than losing it (SPEC §4.3).
        handle: text(row.created_by_terminal_handle),
        name,
        attempts: held,
        spec: preview(spec),
        result: preview(result),
        task,
      };
    })
    .sort(byCreation);
}

/** A body as the conversation gets it: capped, and honest about having been capped. */
export type Preview = { text: string; truncated: boolean };

function preview(body: string | null): Preview | null {
  if (body === null) return null;

  // SQLite was asked for one character past the cap (`BODY_PREVIEW`), so a preview that is
  // *longer* than the cap is the proof that the column held more — no second read, no guess.
  return body.length > BODY_PREVIEW_CHARS
    ? { text: body.slice(0, BODY_PREVIEW_CHARS), truncated: true }
    : { text: body, truncated: false };
}

/**
 * The dispatch attempts, per task, in `rowid` order — insertion order, which is the order they
 * were made in.
 *
 * The **last** one is `MAX(rowid)`: the latest attempt, which is what the node badge shows.
 * Ordering by `dispatched_at` instead would be the bug — a re-dispatch can carry an earlier
 * timestamp than the attempt it follows, and the node would then report a circuit-broken task as
 * freshly dispatched.
 *
 * **All** of them are kept, not just the surviving one, because three separate things are built
 * out of the ones it would otherwise fold away: a run's handle set (`attribution.ts`), the cast
 * (`cast.ts`), and one `dispatch` turn per attempt (`conversation.ts`). A retry is dispatched to
 * a *new* terminal in a *new* worktree — so the first worker's handle exists nowhere else, and
 * dropping it here would silently unattribute every message it ever sent.
 */
function readAttempts(db: DatabaseSync, columns: Columns): Map<string, Dispatch[]> {
  const attempts = new Map<string, Dispatch[]>();

  for (const row of selectPresent(db, 'dispatch_contexts', columns.dispatch_contexts, DISPATCH_COLUMNS)) {
    const taskId = text(row.task_id);
    if (!taskId) continue; // A dispatch context belonging to no task belongs to no node.

    const held = attempts.get(taskId);
    if (held) held.push(toDispatch(row));
    else attempts.set(taskId, [toDispatch(row)]);
  }

  return attempts;
}

export function toDispatch(row: Row): Dispatch {
  const dispatch: Dispatch = {
    id: text(row.id) ?? '',
    assigneeHandle: text(row.assignee_handle) ?? '',
    status: text(row.status) ?? '',
    failureCount: Number(row.failure_count ?? 0),
    lastFailure: isoInstant(row.last_failure),
    // The row is written when the attempt is made, so `created_at` is when it was dispatched
    // for the rows where `dispatched_at` was never filled in.
    dispatchedAt: isoInstant(row.dispatched_at) ?? isoInstant(row.created_at) ?? '',
    completedAt: isoInstant(row.completed_at),
    // Absent before schema v2 — the "last seen" badge is what an older Orca costs you, and
    // `meta.degraded` says so on screen.
    lastHeartbeatAt: isoInstant(row.last_heartbeat_at),
  };

  // The attempt's own clock, both endpoints from this row (#66). Absent when they cannot carry it.
  const duration = dispatchDuration(dispatch);
  if (duration !== undefined) dispatch.duration = duration;

  return dispatch;
}

/**
 * The DAG edges. The column is a JSON string with nothing enforcing that it parses, and a
 * task with an unreadable `deps` still has a status worth seeing — so a broken column costs
 * its edges, never its node.
 *
 * The ids are passed through as they are found, including ids of tasks a reset has since
 * deleted. There are no foreign keys here (SPEC §4.2, trap 8); the *client* drops an edge
 * whose other end is missing, which loses one line rather than the whole graph.
 */
function parseDeps(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((dep): dep is string => typeof dep === 'string') : [];
  } catch {
    return [];
  }
}

/** `task_9f8e7d6c5b4a` → `task_9f8e7d6c`: enough to recognise, and to paste into a CLI. */
function shortId(id: string): string {
  const separator = id.indexOf('_');
  return separator === -1 ? id.slice(0, 8) : id.slice(0, separator + 9);
}

/** Creation order — for a task set with no edges at all, the only structure it has. */
function byCreation(a: TaskWithHandle, b: TaskWithHandle): number {
  return byInstant(a.task.createdAt, b.task.createdAt);
}

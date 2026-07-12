import type { DatabaseSync } from 'node:sqlite';
import type { Dispatch } from '../shared/types.ts';
import { type Columns, isTrue, type Row, selectPresent, text } from './rows.ts';
import type { TaskWithHandle } from './runs.ts';
import { isoInstant } from './time.ts';

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
 * The bodies never cross the SQLite boundary in the first place.
 *
 * `spec` and `result` are only ever asked "are you there?" — so SQLite is asked that, and
 * the 172 KB of agent prompt text a live database holds stays in the file. Reading it into
 * the process to derive two booleans would be the same waste the snapshot exists to avoid
 * (SPEC §6.3).
 */
const BODY_PRESENCE: Record<string, string> = {
  spec: "(spec IS NOT NULL AND spec <> '') AS spec",
  result: "(result IS NOT NULL AND result <> '') AS result",
};

const DISPATCH_COLUMNS = [
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

  return selectPresent(db, 'tasks', columns.tasks, TASK_COLUMNS, BODY_PRESENCE)
    .map((row): TaskWithHandle => {
      const id = text(row.id) ?? '';
      const attempt = attempts.get(id);
      // Pre-v5 Orca named neither. A *task* then falls back to its short id; a *run* falls
      // back to its handle — so the name is passed on unresolved, and each falls back its own way.
      const name = text(row.task_title) ?? text(row.display_name);

      return {
        // Absent before schema v4, and null on 4 of 76 live tasks even now: both land the
        // task in the one synthetic `run_unattributed` rather than losing it (SPEC §4.3).
        handle: text(row.created_by_terminal_handle),
        name,
        task: {
          id,
          // Filled by `inferRuns` — the schema has no run id, so nothing here can read one.
          runId: '',
          // #19 derives gates from `decision_gate` messages, never the empty gates table.
          gate: null,
          parentId: text(row.parent_id),
          title: name ?? shortId(id),
          // Verbatim: a status this tool has never heard of still names a real state, and a
          // task missing from the graph is a worse lie than a task in an odd colour (SPEC §5).
          status: text(row.status) ?? '',
          deps: parseDeps(row.deps),
          createdAt: isoInstant(row.created_at) ?? '',
          completedAt: isoInstant(row.completed_at),
          hasSpec: isTrue(row.spec),
          hasResult: isTrue(row.result),
          dispatch: attempt ? toDispatch(attempt.latest) : null,
          attemptCount: attempt?.count ?? 0,
        },
      };
    })
    .sort(byCreation);
}

type Attempts = { latest: Row; count: number };

/**
 * The dispatch attempts, folded per task.
 *
 * `ORDER BY rowid` and last-one-wins *is* `MAX(rowid)` — spelled as a fold because the
 * attempt count falls out of the same pass. Ordering by `dispatched_at` instead would be
 * the bug: a re-dispatch can carry an earlier timestamp than the attempt it follows, and
 * the node would then report a circuit-broken task as freshly dispatched.
 */
function readAttempts(db: DatabaseSync, columns: Columns): Map<string, Attempts> {
  const attempts = new Map<string, Attempts>();

  for (const row of selectPresent(db, 'dispatch_contexts', columns.dispatch_contexts, DISPATCH_COLUMNS)) {
    const taskId = text(row.task_id);
    if (!taskId) continue; // A dispatch context belonging to no task belongs to no node.
    attempts.set(taskId, { latest: row, count: (attempts.get(taskId)?.count ?? 0) + 1 });
  }

  return attempts;
}

function toDispatch(row: Row): Dispatch {
  return {
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
  return instant(a.task.createdAt) - instant(b.task.createdAt);
}

function instant(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

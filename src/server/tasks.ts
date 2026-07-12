import type { DatabaseSync } from 'node:sqlite';
import type { Dispatch, Task } from '../shared/types.ts';
import type { SchemaReport } from './schema.ts';
import { isoInstant } from './time.ts';

/**
 * The DAG, read out of `tasks` and `dispatch_contexts`.
 *
 * Three things this owes the client, none of which it can work out for itself:
 *
 * 1. **The bodies are omitted.** `spec` and `result` become `hasSpec` / `hasResult` — a live
 *    71-task dump was 172 KB, almost entirely spec text (SPEC §6.3). `GET /api/task/:id`
 *    fetches them on click (#20).
 * 2. **The latest dispatch attempt is `MAX(rowid)`**, as Orca's own queries have it — never
 *    the latest `dispatched_at`, which a retry can order backwards. `attemptCount` counts
 *    them all, and it is the *only* visible sign anywhere in this schema that a task was
 *    retried (SPEC §7.5).
 * 3. **Every timestamp is an ISO-8601 UTC instant** (`time.ts`).
 *
 * Every query is built from the columns the database really has (`schema.ts`), so an older
 * Orca costs exactly the badge whose column is missing — never the graph.
 */

type Row = Record<string, unknown>;
type Columns = SchemaReport['columns'];

/** Read if present. `tasks.id` / `status` / `deps` are the DAG core and always are. */
const TASK_COLUMNS = [
  'id',
  'parent_id',
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

export function readTasks(db: DatabaseSync, columns: Columns): Task[] {
  const attempts = readAttempts(db, columns);

  return selectPresent(db, 'tasks', columns.tasks, TASK_COLUMNS, BODY_PRESENCE)
    .map((row): Task => {
      const id = text(row.id) ?? '';
      const attempt = attempts.get(id);

      return {
        id,
        // Runs are inferred in #16 and gates derived in #19. Until they are, saying "no run"
        // is the honest answer — every task in the database renders as one graph, which is
        // the unusable soup that motivates run scoping in the first place.
        runId: '',
        gate: null,
        parentId: text(row.parent_id),
        title: text(row.task_title) ?? text(row.display_name) ?? shortId(id),
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
 * SELECT only what the file really has: never name a column this Orca never added.
 *
 * Always in `rowid` order, which is insertion order — the order the dispatch fold depends on
 * for `MAX(rowid)`, and a stable base order for everything else.
 */
function selectPresent(
  db: DatabaseSync,
  table: string,
  present: ReadonlySet<string>,
  wanted: readonly string[],
  projected: Record<string, string> = {}
): Row[] {
  const columns = wanted.filter((column) => present.has(column));
  if (columns.length === 0) return [];

  const selected = columns.map((column) => projected[column] ?? column);
  return db.prepare(`SELECT ${selected.join(', ')} FROM ${table} ORDER BY rowid`).all() as Row[];
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

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** SQLite has no boolean type: a comparison comes back as the integer 1 or 0. */
function isTrue(value: unknown): boolean {
  return value === 1;
}

/** Creation order — for a task set with no edges at all, the only structure it has. */
function byCreation(a: Task, b: Task): number {
  return instant(a.createdAt) - instant(b.createdAt);
}

function instant(iso: string): number {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? 0 : at;
}

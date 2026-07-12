import type { DatabaseSync } from 'node:sqlite';
import type { Dispatch, TaskDetail } from '../shared/types.ts';
import type { Attribution } from './attribution.ts';
import { readMessages } from './messages.ts';
import { type Columns, selectWhere, text } from './rows.ts';
import { DISPATCH_TASK_ID, hasColumn } from './schema.ts';
import { DISPATCH_COLUMNS, toDispatch } from './tasks.ts';

/**
 * The whole story of one task — what `GET /api/task/:id` reads, and the only place in this
 * server that opens the bodies (#20, SPEC §7.8).
 *
 * It is the inverse of the snapshot, in the two places the snapshot deliberately stops short:
 *
 * 1. **The bodies.** `spec` and `result` never travel in a snapshot — 172 KB of agent prompt on
 *    a live database, sent every five seconds to a page that shows one task's at a time (SPEC
 *    §6.3). They are read here, for the one task that was clicked, and nowhere else.
 * 2. **Every attempt, not the latest.** The snapshot folds `dispatch_contexts` down to
 *    `MAX(rowid)` plus `attemptCount`, because a node has room for one badge. The retry story
 *    lives in the rows it folded away: who else held this task, how many times it failed, and
 *    whether the third attempt tripped the circuit breaker. `dispatch_contexts` is the only
 *    genuinely append-only per-task history in this schema, and a silent re-dispatch must not
 *    read as a first attempt.
 *
 * What it does **not** carry, it does not carry on purpose: the gate Q&A and the dependency
 * chips are on the wire already (`snapshot.gates` from #19, `Task.deps` from #15). A second copy
 * of either, fetched down a different route, is a second copy that can disagree with the first.
 */

/** The two bodies, and the id that proves the task is really there. */
const TASK_BODY_COLUMNS = ['id', 'spec', 'result'] as const;

/**
 * The detail, or **null when no such task exists** — which is a 404 and not an empty detail.
 *
 * A task id that resolves to nothing is a real case, not a bug: ids are pasted by hand, and an
 * `orchestration reset` deletes tasks that messages elsewhere in the file still name (SPEC §4.2,
 * trap 8). Answering with an empty body would dress an id that means nothing up as a task with
 * nothing to say.
 */
export function readTaskDetail(
  db: DatabaseSync,
  columns: Columns,
  id: string,
  attribution: Attribution
): TaskDetail | null {
  // `tasks.id` is DAG core, so it is always there to be asked. The bodies may not be — an Orca
  // without them costs exactly the panel that shows them (`schema.ts`), never the query.
  const [row] = selectWhere(db, 'tasks', columns.tasks, TASK_BODY_COLUMNS, 'WHERE id = ? LIMIT 1', [id]);
  if (row === undefined) return null;

  return {
    id,
    spec: text(row.spec),
    result: text(row.result),
    attempts: readAttempts(db, columns, id),
    messages: readTaskMessages(db, columns, id, attribution),
  };
}

/**
 * Every attempt, in `rowid` order — insertion order, which is the order they were made in.
 *
 * Never `ORDER BY dispatched_at`: a re-dispatch can carry an earlier timestamp than the attempt
 * it follows, and an attempt history that sorted by it would tell the retry story backwards.
 * `rowid` is the same order `MAX(rowid)` folds against in the snapshot (`tasks.ts`), so the last
 * row here is exactly the one the node badge shows.
 */
function readAttempts(db: DatabaseSync, columns: Columns, id: string): Dispatch[] {
  // `task_id` is what ties an attempt to a task at all. Without it there is no honest way to
  // say which attempts were this task's — and `meta.degraded` says so on screen (#21).
  if (!hasColumn(columns, DISPATCH_TASK_ID)) return [];

  const rows = selectWhere(
    db,
    'dispatch_contexts',
    columns.dispatch_contexts,
    DISPATCH_COLUMNS,
    'WHERE task_id = ? ORDER BY rowid',
    [id]
  );

  return rows.map(toDispatch);
}

/**
 * The messages that referenced this task, in `sequence` order.
 *
 * Filtered in JS rather than in SQL, and that is the careful choice: the link is `payload.taskId`
 * inside a TEXT column with nothing enforcing that it holds JSON at all, and SQLite's
 * `json_extract` *errors* on a payload that does not parse. One malformed row would take the
 * whole route down with it. `parsePayload` already answers "no" to a blob it cannot read (SPEC
 * §5), so the same reader the feed uses does the filtering here — over 466 rows on a live
 * database, which is nothing.
 *
 * It goes through `readMessages` rather than around it so an inspector row and a feed row are
 * the same `FeedMessage`, attributed by the same rules (`attribution.ts`) and rendered by the
 * same component. Heartbeats come with them: they are 65% of the traffic and the panel hides
 * them by default, but the hiding is the *client's* (SPEC §7.7) — a wire that dropped them would
 * put rows behind a toggle the user can turn back on.
 */
function readTaskMessages(db: DatabaseSync, columns: Columns, id: string, attribution: Attribution) {
  return readMessages(db, columns, { since: 0, attribution }).filter((message) => message.taskId === id);
}

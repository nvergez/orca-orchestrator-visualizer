import type { CoordinatorRun, Dispatch, Gate, Run, RunSnapshot, Task, Turn } from '../shared/types.ts';
import { byInstant } from './time.ts';

/**
 * **History that pages, and selected runs that never do** (SPEC §12, ADR 0002, #69).
 *
 * The database is never pruned, so "send everything on every tick" grows without bound. This
 * module is the replacement contract, in three pure pieces:
 *
 * - **The run index** (`pageRuns`): the navigation surface — summaries, most recently active
 *   first, a page at a time behind an opaque keyset cursor. Older history stays *explicitly*
 *   reachable; there is no silent date cutoff.
 * - **The selected-run snapshot** (`snapshotRun`): the complete retained evidence for one run —
 *   every task, attempt, gate and turn, plus the dependency neighbours the inspector's chips
 *   need. Bounding the index is not allowed to weaken a post-mortem, so nothing here windows
 *   or truncates.
 * - **The digests** (`digestRuns`): one fingerprint per run over exactly the evidence its
 *   snapshot serves, so the stream can *name* the runs a change touched
 *   (`StreamEvent.affected`) instead of re-shipping the machine's whole history.
 *
 * Pure, and free of SQLite **and of Node**: the query layer hands it what one derivation pass
 * already produced (`database.ts`), the same way `runs.ts` is handed tasks — and the canned
 * client suite imports these same functions to build its stub loaders (`test/client/canned.tsx`),
 * so a canned selected run cannot drift from what the real endpoint serves. The digests, which
 * want `node:crypto`, live next door in `digests.ts` for exactly that reason.
 */

/** The three keys the run order reads — all a keyset cursor has to remember. */
export type RunOrderKeys = Pick<Run, 'endedAt' | 'startedAt' | 'id'>;

/**
 * Most-recent activity first — the rail's order, the run index's order, and a **total** order.
 *
 * The id tie-break is not pedantry: the run index pages this order with a keyset cursor (#69),
 * and a cursor over an order with ties is a page boundary that falls differently on two reads
 * of an unchanged database — duplicating a run into two pages or dropping it from both. The id
 * is compared by code point, never by locale, because a page boundary must not move with the
 * server's `LANG`.
 */
export function byMostRecentActivity(a: RunOrderKeys, b: RunOrderKeys): number {
  return (
    byInstant(b.endedAt, a.endedAt) ||
    byInstant(b.startedAt, a.startedAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/** The first page is the 50 most recently active summaries (SPEC §12). */
export const RUN_PAGE_SIZE = 50;

/** A named refusal the HTTP edge can turn into a 400 rather than a 500. */
export class CursorError extends Error {
  constructor(cursor: string) {
    super(`Not a run-index cursor: ${JSON.stringify(cursor)}. Follow the nextCursor a previous page returned.`);
  }
}

/**
 * Everything one derivation pass produced — machine-global, exactly once per read. The three
 * derivations below are different projections of it, which is what keeps the index, the
 * snapshot and the digests incapable of disagreeing about what a run contains.
 */
export type RunEvidence = {
  /** Already in `byMostRecentActivity` order — the inference sorts them (`runs.ts`). */
  runs: Run[];
  /** Every task, in creation order, each carrying its run id. */
  tasks: Task[];
  /** Every dispatch attempt per task, oldest first — the append-only retry record. */
  attemptsByTask: ReadonlyMap<string, Dispatch[]>;
  gates: Gate[];
  /** The whole conversation, in its one chronological order (`conversation.ts`). */
  turns: Turn[];
  coordinatorRuns: CoordinatorRun[];
};

export type RunPage = {
  runs: Run[];
  nextCursor: string | null;
};

/**
 * One page of the index, after `cursor` — or the newest page when there is none.
 *
 * The cursor is a **keyset**: the order keys of the last row served, not an offset. A run that
 * gains activity between two page fetches moves *ahead* of every existing cursor position, so
 * it can never duplicate into a later page — it surfaces where changed runs surface, at the
 * top of a refreshed first page (which `StreamEvent.affected` tells the client to fetch). On
 * an unchanged database the pages tile history exactly: no duplicates, no omissions.
 */
export function pageRuns(runs: Run[], cursor: string | null, pageSize = RUN_PAGE_SIZE): RunPage {
  const after = cursor === null ? null : decodeCursor(cursor);

  // Strictly after the cursor position in the total order — by *keys*, not by finding the row:
  // the row the cursor was cut from may have changed activity or been reset away entirely, and
  // the page boundary has to stay where the client saw it, not where that row went.
  const rest = after === null ? runs : runs.filter((run) => byMostRecentActivity(after, run) < 0);

  const page = rest.slice(0, pageSize);

  return {
    runs: page,
    // Null means "history ends here", so it is only said when it is true.
    nextCursor: rest.length > pageSize ? encodeCursor(page[page.length - 1]!) : null,
  };
}

/**
 * The cursor is opaque on the wire — a contract, not an encryption: the client follows it
 * verbatim and never interprets it. Underneath it is deliberately boring — the three order
 * keys, as JSON. Deterministic (the same database yields the same cursor), and carrying
 * nothing a client could not already see on the row it was cut after.
 */
function encodeCursor(run: RunOrderKeys): string {
  return JSON.stringify({ endedAt: run.endedAt, startedAt: run.startedAt, id: run.id });
}

/** Garbage in is a `CursorError` out — a 400 with its own name, never a silent first page. */
function decodeCursor(cursor: string): RunOrderKeys {
  try {
    const parsed = JSON.parse(cursor) as Record<string, unknown>;
    const { endedAt, startedAt, id } = parsed;
    if (typeof endedAt === 'string' && typeof startedAt === 'string' && typeof id === 'string') {
      return { endedAt, startedAt, id };
    }
  } catch {
    // Fall through: not JSON, or not ours — the same refusal either way.
  }
  throw new CursorError(cursor);
}

/**
 * The complete retained evidence for one run — everything `GET /api/run/:id` serves except
 * `meta`, which is the connection's to add. Null when no run has this id: an id that names
 * nothing is a 404, not a run with nothing to say.
 */
export function snapshotRun(evidence: RunEvidence, runId: string): Omit<RunSnapshot, 'meta'> | null {
  const run = evidence.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return null;

  const tasks = evidence.tasks.filter((task) => task.runId === runId);

  return {
    run,
    tasks,
    attempts: attemptsOf(tasks, evidence.attemptsByTask),
    gates: evidence.gates.filter((gate) => gate.runId === runId),
    // This run's conversation, and the turns nothing places (SPEC §4.4, rule 3) — one filter
    // pass over the server's chronological order, so the two interleave the way they happened.
    turns: evidence.turns.filter((turn) => turn.runId === runId || turn.runId === null),
    linkedTasks: linkedTasksOf(evidence.tasks, tasks),
    coordinatorRuns: coordinatorRunsOf(evidence.coordinatorRuns, run),
  };
}

/** Every attempt of every task that has any, oldest first, keyed by task id. */
function attemptsOf(tasks: Task[], attemptsByTask: ReadonlyMap<string, Dispatch[]>): Record<string, Dispatch[]> {
  const attempts: Record<string, Dispatch[]> = {};

  for (const task of tasks) {
    const rows = attemptsByTask.get(task.id);
    if (rows !== undefined && rows.length > 0) attempts[task.id] = rows;
  }

  return attempts;
}

/**
 * The far ends of every dependency edge that crosses this run's boundary — in either
 * direction, deduplicated, in the creation order `allTasks` already has. There are no foreign
 * keys here, so a dep naming a task that no longer exists simply contributes nothing.
 */
function linkedTasksOf(allTasks: Task[], runTasks: Task[]): Task[] {
  const inRun = new Set(runTasks.map((task) => task.id));

  const linkedIds = new Set<string>();
  for (const task of runTasks) {
    for (const dep of task.deps) {
      if (!inRun.has(dep)) linkedIds.add(dep);
    }
  }

  return allTasks.filter(
    (task) => !inRun.has(task.id) && (linkedIds.has(task.id) || task.deps.some((dep) => inRun.has(dep)))
  );
}

/** The coordinator rows that belong to this orchestrator — none can belong to the synthetic run. */
function coordinatorRunsOf(rows: CoordinatorRun[], run: Run): CoordinatorRun[] {
  if (run.handle === null) return [];
  return rows.filter((row) => row.coordinatorHandle === run.handle);
}

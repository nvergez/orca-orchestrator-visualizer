import type {
  CoordinatorRun,
  Dispatch,
  Gate,
  ReceiptFact,
  Run,
  RunIndexPage,
  RunSnapshot,
  Task,
  Turn,
} from '../shared/types.ts';
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
  /**
   * The whole outcome receipt of every task that has one (#67), merged across both evidence
   * columns with provenance — the reading the report's rows summarize (#70) and the inspector
   * shows in full. Absent from the map ⇒ nothing was recognized, which is an ordinary shape and
   * never schema drift. Built once per read, beside everything else here, because the report
   * asks it of every task at once (`database.ts`).
   */
  receiptsByTask: ReadonlyMap<string, ReceiptFact[]>;
};

/** One page of the run index — `RunIndexPage` minus the header the connection adds. */
export type IndexPage = Omit<RunIndexPage, 'meta' | 'coordinatorRuns'>;

/**
 * One page of the index, after `cursor` — or the newest page when there is none.
 *
 * The cursor is a **keyset**: the order keys of the last row served, not an offset. A run that
 * gains activity between two page fetches moves *ahead* of every existing cursor position, so
 * it can never duplicate into a later page — it surfaces where changed runs surface, at the
 * top of a refreshed first page (which `StreamEvent.affected` tells the client to fetch). On
 * an unchanged database the pages tile history exactly: no duplicates, no omissions.
 */
export function pageRuns(runs: Run[], cursor: string | null, pageSize = RUN_PAGE_SIZE): IndexPage {
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
 * **Every run's evidence, bucketed in one pass over the database's** — so that projecting any
 * one run is a lookup rather than a scan (`digests.ts` fingerprints *every* run on a changed
 * tick, and a per-run scan there would make the poll loop O(runs × history) — the very cost
 * this ticket exists to bound).
 *
 * It also settles two questions **once** that two callers would otherwise each answer: which
 * coordinator rows belong to a run, and which belong to nobody. A rule written twice is a rule
 * that can be changed once.
 */
export type EvidenceIndex = {
  runsById: Map<string, Run>;
  tasksByRun: Map<string, Task[]>;
  gatesByRun: Map<string, Gate[]>;
  /** A run's own turns. The unplaced ones are apart, because they belong to nobody. */
  turnsByRun: Map<string, Turn[]>;
  /** Turns nothing places (SPEC §4.4, rule 3). Every snapshot carries them; no run owns them. */
  unplacedTurns: Turn[];
  /** The far ends of dependency edges that cross a run's boundary — either direction. */
  linkedTasksByRun: Map<string, Task[]>;
  coordinatorRunsByRun: Map<string, CoordinatorRun[]>;
  /** Coordinator rows naming a handle no orchestrator has — the other half of "unplaced". */
  orphanCoordinatorRuns: CoordinatorRun[];
  attemptsByTask: ReadonlyMap<string, Dispatch[]>;
};

export function indexEvidence(evidence: RunEvidence): EvidenceIndex {
  const runsById = new Map(evidence.runs.map((run) => [run.id, run]));
  const tasksByRun = bucket(evidence.tasks, (task) => task.runId);
  const gatesByRun = bucket(evidence.gates, (gate) => gate.runId);
  const turnsByRun = bucket(evidence.turns, (turn) => turn.runId);

  // The dependency edges that cross a run boundary, walked **once** for the whole database
  // rather than once per run. There are no foreign keys here, so a dep naming a task that no
  // longer exists simply contributes nothing (SPEC §4.2, trap 8).
  const taskById = new Map(evidence.tasks.map((task) => [task.id, task]));
  const linkedInto = new Map<string, Set<string>>(); // task id → the runs it is a far end for
  const linkInto = (runId: string, taskId: string): void => {
    const runs = linkedInto.get(taskId);
    if (runs) runs.add(runId);
    else linkedInto.set(taskId, new Set([runId]));
  };

  for (const task of evidence.tasks) {
    for (const dep of new Set(task.deps)) {
      const target = taskById.get(dep);
      if (target === undefined || target.runId === task.runId) continue;
      // The edge crosses: each end is the other's neighbour, and each run needs the far one.
      linkInto(task.runId, target.id);
      linkInto(target.runId, task.id);
    }
  }

  // Filled by one pass over the tasks, so each run's neighbours keep the creation order the
  // canvas and the inspector's dep chips read them in.
  const linkedTasksByRun = new Map<string, Task[]>();
  for (const task of evidence.tasks) {
    for (const runId of linkedInto.get(task.id) ?? []) {
      const linked = linkedTasksByRun.get(runId);
      if (linked) linked.push(task);
      else linkedTasksByRun.set(runId, [task]);
    }
  }

  const runIdOfHandle = new Map(
    evidence.runs.filter((run) => run.handle !== null).map((run) => [run.handle!, run.id])
  );
  const coordinatorRunsByRun = new Map<string, CoordinatorRun[]>();
  const orphanCoordinatorRuns: CoordinatorRun[] = [];

  for (const row of evidence.coordinatorRuns) {
    const runId = runIdOfHandle.get(row.coordinatorHandle);
    if (runId === undefined) {
      orphanCoordinatorRuns.push(row);
      continue;
    }
    const rows = coordinatorRunsByRun.get(runId);
    if (rows) rows.push(row);
    else coordinatorRunsByRun.set(runId, [row]);
  }

  return {
    runsById,
    tasksByRun,
    gatesByRun,
    turnsByRun,
    unplacedTurns: turnsByRun.get(UNPLACED) ?? [],
    linkedTasksByRun,
    coordinatorRunsByRun,
    orphanCoordinatorRuns,
    attemptsByTask: evidence.attemptsByTask,
  };
}

/**
 * The complete retained evidence for one run — everything `GET /api/run/:id` serves except
 * `meta`, which is the connection's to add. Null when no run has this id: an id that names
 * nothing is a 404, not a run with nothing to say.
 */
export function snapshotRun(evidence: RunEvidence, runId: string): Omit<RunSnapshot, 'meta'> | null {
  return snapshotFrom(indexEvidence(evidence), runId);
}

/** The same snapshot, from an index a caller already built — what fingerprinting every run needs. */
export function snapshotFrom(index: EvidenceIndex, runId: string): Omit<RunSnapshot, 'meta'> | null {
  const run = index.runsById.get(runId);
  if (run === undefined) return null;

  const tasks = index.tasksByRun.get(runId) ?? [];

  return {
    run,
    tasks,
    attempts: attemptsOf(tasks, index.attemptsByTask),
    gates: index.gatesByRun.get(runId) ?? [],
    // This run's conversation **and the turns nothing places** (SPEC §4.4, rule 3), merged back
    // into the one chronological order the server derived them in — so the two interleave the
    // way they happened rather than the unplaced ones piling up at the end.
    turns: chronological(index.turnsByRun.get(runId) ?? [], index.unplacedTurns),
    linkedTasks: index.linkedTasksByRun.get(runId) ?? [],
    coordinatorRuns: index.coordinatorRunsByRun.get(runId) ?? [],
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
 * Two lists already in the conversation's order, merged back into one. A plain concatenation
 * would work only until somebody read it: the panel renders oldest-first (SPEC §7.7), and an
 * unplaced turn from Tuesday appended after today's report is a story told out of order.
 */
function chronological(runTurns: Turn[], unplaced: Turn[]): Turn[] {
  if (unplaced.length === 0) return runTurns;

  const merged: Turn[] = [];
  let left = 0;
  let right = 0;

  while (left < runTurns.length && right < unplaced.length) {
    merged.push(byInstant(runTurns[left]!.at, unplaced[right]!.at) <= 0 ? runTurns[left++]! : unplaced[right++]!);
  }

  return [...merged, ...runTurns.slice(left), ...unplaced.slice(right)];
}

/**
 * The key `null` takes — evidence nothing places. It can never collide with a run id: those are
 * `run_<handle>` or `run_unattributed`, and this deliberately is not. The digests key their
 * "unplaced changed" fingerprint on the same string (`digests.ts`), because it is the same fact.
 */
export const UNPLACED = '@unplaced';

/** Group in one pass, preserving the order the caller derived. A null key is the unplaced bucket. */
function bucket<T>(items: T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const buckets = new Map<string, T[]>();

  for (const item of items) {
    const key = keyOf(item) ?? UNPLACED;
    const existing = buckets.get(key);
    if (existing) existing.push(item);
    else buckets.set(key, [item]);
  }

  return buckets;
}

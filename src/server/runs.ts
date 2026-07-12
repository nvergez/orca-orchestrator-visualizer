import { shortHandle } from '../shared/handles.ts';
import { type Run, type Task, TASK_STATUSES, type TaskStatus } from '../shared/types.ts';
import { byInstant, instantOf } from './time.ts';

/**
 * Run inference — the thing the schema does not have.
 *
 * There is **no run id in the schema**. A run is a guess, and the whole tool rests on it: it
 * is what turns 76 tasks in one unreadable soup into 13 orchestrations you can pick between.
 * So the guess is made once, here, on the server, and the UI says out loud that it is a guess
 * (the rail is headed "Runs (inferred)").
 *
 * Every rule below was paid for by a shape the live database really has (SPEC §4.3):
 *
 * 1. **Bucket by `created_by_terminal_handle`. The handle is the primary key; time is only
 *    the tiebreaker.** Two handles genuinely overlap in time in real data — a time-first
 *    clustering would merge two unrelated orchestrations into one.
 * 2. **Null-handle tasks are one run, not none.** 4 of 76 live tasks have no handle. They
 *    collect into a single synthetic `run_unattributed` rather than vanishing off the rail.
 * 3. **Split on an idle gap of more than six hours** — hours, not minutes: a real 13-task
 *    run spans 20:10 → 07:04 overnight, and any shorter threshold shreds it.
 * 4. **The ids are deterministic**, because a rail whose rows change identity on every
 *    restart cannot hold a selection, and history is the point of this tool.
 *
 * The module is deliberately **pure** — tasks in, runs out, no SQLite. Reading rows is the
 * query layer's job (`tasks.ts`); this is the derivation, and the two tickets that build on
 * it (#17's poll loop, #21's degradation) can each call it without touching the other.
 */

/** More than six hours of silence from one terminal ends a run and starts the next. */
export const IDLE_GAP_MS = 6 * 60 * 60 * 1000;

/** The one bucket for tasks Orca never attributed to a terminal. Not a real handle's run. */
export const UNATTRIBUTED_RUN_ID = 'run_unattributed';

/** …and the rail says exactly that, rather than dressing the orphans up as an orchestration. */
export const UNATTRIBUTED_LABEL = 'Unattributed';

/** A run is live only while it still has work that could move. */
const IN_FLIGHT: ReadonlySet<string> = new Set<TaskStatus>(['ready', 'dispatched']);

/**
 * A task as the database has it, plus the two things the wire contract deliberately does not
 * carry on a task — and that run inference cannot work without.
 */
export type TaskWithHandle = {
  /** The task itself. Its `runId` is empty until this module fills it in. */
  task: Task;
  /** `created_by_terminal_handle` — the run key. Null for 4 of 76 live tasks, and pre-v4 Orca has no such column at all. */
  handle: string | null;
  /**
   * `task_title ?? display_name`, or null when Orca never named the task.
   *
   * Not the same thing as `Task.title`: a *task* with no name falls back to its short id,
   * while a *run* with no name falls back to its handle. One chain cannot serve both, and
   * reusing `Task.title` here would silently label a run with a task id.
   */
  name: string | null;
};

export type InferredRuns = {
  /** Most recently active first — the rail's order, and so the run that opens by default. */
  runs: Run[];
  /** The same tasks, in the same order, each now carrying the run it belongs to. */
  tasks: Task[];
};

export type RunOptions = {
  /** `meta.liveness === 'live'`. A run is live only if Orca itself is (SPEC §7.3). */
  orcaIsLive: boolean;
};

export function inferRuns(entries: TaskWithHandle[], { orcaIsLive }: RunOptions): InferredRuns {
  const runs: Run[] = [];
  const runIdOfTask = new Map<string, string>();

  for (const [handle, members] of bucketByHandle(entries)) {
    for (const segment of segmentsOf(handle, members)) {
      const run = describeRun(handle, segment, orcaIsLive);
      runs.push(run);
      for (const entry of segment) runIdOfTask.set(entry.task.id, run.id);
    }
  }

  runs.sort(byMostRecentActivity);

  return {
    runs,
    // Mapped over the entries as they were read, so the creation order the canvas depends on
    // for its isolated-task grid survives the trip through the buckets.
    //
    // The lookup is total by construction: every entry went into exactly one bucket, every
    // bucket into exactly one segment, and every segment became a run. A fallback here would
    // not be caution — it would hand a task a run id that names no row in the rail, which is
    // a task nothing can ever render.
    tasks: entries.map((entry) => ({ ...entry.task, runId: runIdOfTask.get(entry.task.id)! })),
  };
}

/**
 * Step 1 — and the load-bearing one. Everything a terminal created belongs to that terminal's
 * runs, whatever else was happening at the same moment.
 */
function bucketByHandle(entries: TaskWithHandle[]): Map<string | null, TaskWithHandle[]> {
  const buckets = new Map<string | null, TaskWithHandle[]>();

  for (const entry of entries) {
    const bucket = buckets.get(entry.handle);
    if (bucket) bucket.push(entry);
    else buckets.set(entry.handle, [entry]);
  }

  return buckets;
}

/**
 * Step 3 — the six-hour split, applied within one handle's bucket.
 *
 * The null bucket is **not** split: it is one run by definition (step 2), and splitting it
 * would produce several runs all claiming the same `run_unattributed` id. Those tasks share
 * nothing but the absence of a handle; a gap between them means nothing.
 */
function segmentsOf(handle: string | null, members: TaskWithHandle[]): TaskWithHandle[][] {
  const ordered = [...members].sort((a, b) => byInstant(a.task.createdAt, b.task.createdAt));
  if (handle === null) return [ordered];

  const segments: TaskWithHandle[][] = [];
  let current: TaskWithHandle[] = [];
  let previous: number | null = null;

  for (const entry of ordered) {
    const createdAt = instantOf(entry.task.createdAt);

    // Strictly *more* than six hours: a run that idled exactly six is still that run.
    //
    // And a gap is only a gap between two instants we can actually read. A task whose
    // `created_at` holds something unparseable sorts to the back of its bucket and joins the
    // run it belongs to — measuring a "gap" against it would split a healthy run over a bad
    // column, and mint a ghost run dated 1970 to hold the one task.
    if (previous !== null && createdAt !== null && createdAt - previous > IDLE_GAP_MS) {
      segments.push(current);
      current = [];
    }

    current.push(entry);
    if (createdAt !== null) previous = createdAt;
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

/** Everything a rail row shows, so the interesting run can be picked without opening it. */
function describeRun(handle: string | null, segment: TaskWithHandle[], orcaIsLive: boolean): Run {
  const first = segment[0]!;
  const tasks = segment.map((entry) => entry.task);

  return {
    id: runIdFor(handle, first.task),
    handle,
    label: labelFor(handle, first),
    startedAt: first.task.createdAt,
    endedAt: lastActivity(tasks),
    taskCount: tasks.length,
    statusCounts: countStatuses(tasks),
    // No history mode: yesterday's run renders through this same code path, and the dot is
    // the whole difference. It takes a running Orca *and* work that could still move.
    live: orcaIsLive && tasks.some((task) => IN_FLIGHT.has(task.status)),
    // #19 derives gates from `decision_gate` messages and fills this in. Claiming open gates
    // we have not looked for would raise a gate strip over an empty question.
    hasOpenGates: false,
    edgeCount: countEdges(tasks),
  };
}

/**
 * `run_<handle8>_<epoch seconds of the first task>` — deterministic, and stable across
 * restarts, because the rail cannot hold a selection across ids that change on every boot.
 */
function runIdFor(handle: string | null, first: Task): string {
  if (handle === null) return UNATTRIBUTED_RUN_ID;
  return `run_${shortHandle(handle)}_${Math.floor((instantOf(first.createdAt) ?? 0) / 1000)}`;
}

/**
 * What the run was trying to do: the earliest task's title, then its display name, then the
 * terminal that ran it. In practice a run's first task names the work.
 */
function labelFor(handle: string | null, first: TaskWithHandle): string {
  if (handle === null) return UNATTRIBUTED_LABEL;
  return first.name ?? shortHandle(handle);
}

/**
 * When the run last did anything — the max of every completion and every creation, which is
 * what the rail sorts on. A run's last task can outlive the last task it *started*.
 */
function lastActivity(tasks: Task[]): string {
  let latest = tasks[0]!.createdAt;

  for (const task of tasks) {
    for (const at of [task.createdAt, task.completedAt]) {
      if (at !== null && byInstant(at, latest) > 0) latest = at;
    }
  }

  return latest;
}

/**
 * The breakdown the rail shows ("6 done / 1 failed"). The six known statuses are always
 * present, at zero when the run has none of them; a status this build has never heard of is
 * counted under its own raw name rather than dropped — a task missing from the tally is a
 * task the rail lies about (SPEC §5).
 */
function countStatuses(tasks: Task[]): Record<string, number> {
  // A bare object, not an object literal: a status Orca invents is a *key* here, and on an
  // ordinary object a key like `__proto__` would be swallowed by the prototype setter rather
  // than counted — dropping the very task this function promises never to drop.
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const status of TASK_STATUSES) counts[status] = 0;

  for (const task of tasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }

  return counts;
}

/**
 * The dependency edges *inside* this run — `0` is the edgeless empty state, and 4 of 13 real
 * runs are edgeless.
 *
 * A dep naming a task in another run, or one an `orchestration reset` deleted, is not an edge:
 * there are no foreign keys here (SPEC §4.2, trap 8), and the canvas cannot draw a line to a
 * node that is not on it. Counting one would promise a DAG the user never gets.
 */
function countEdges(tasks: Task[]): number {
  const inRun = new Set(tasks.map((task) => task.id));

  // Distinct deps: the column is an unvalidated JSON array, and a task listing the same
  // dependency twice is still one line on the canvas. Counting it twice would keep a run out
  // of the edgeless state over an edge nobody can see.
  return tasks.reduce(
    (total, task) => total + [...new Set(task.deps)].filter((dep) => inRun.has(dep)).length,
    0
  );
}

/** The rail sorts by most-recent activity, so the run worth opening is the one on top. */
function byMostRecentActivity(a: Run, b: Run): number {
  return byInstant(b.endedAt, a.endedAt) || byInstant(b.startedAt, a.startedAt);
}

import { shortHandle } from '../shared/handles.ts';
import { type Dispatch, type Run, type Task, TASK_STATUSES, type TaskStatus, type Wave } from '../shared/types.ts';
import { castOf } from './cast.ts';
import type { Preview } from './tasks.ts';
import { byInstant, instantOf } from './time.ts';

/**
 * **An orchestrator, and everything it dispatched.**
 *
 * A row in the rail is one `created_by_terminal_handle` — a Claude Code session that was told to
 * coordinate. That is not a guess: the column says which terminal created a task, and the tool
 * simply never said so on screen. What *was* a guess, and what this module has stopped doing, is
 * using the six-hour idle gap to decide a row's **identity**:
 *
 * > A terminal reused across four days used to become several unrelated rows in the rail, and
 * > nothing on screen ever said why. The rule was invisible and its consequences were not.
 *
 * So the rule is **demoted, not deleted**. It is the same threshold (`IDLE_GAP_MS`) doing a new
 * job: it cuts an orchestrator's tasks into **waves**, which the canvas draws as bordered regions
 * captioned with the gap that opened them ("Wave 2 · after 14h idle"). The time gap is now
 * *shown* instead of *imposed* (SPEC §4.3).
 *
 * What survives from the old inference, because the live data still insists on it:
 *
 * 1. **Bucket by the handle. The handle is the key; time is not.** Two handles genuinely overlap
 *    in time in real data — a time-first clustering would merge two unrelated orchestrations.
 * 2. **Null-handle tasks are one run, not none.** 4 of 76 live tasks have no handle. They collect
 *    into a single synthetic `run_unattributed` rather than vanishing off the rail. It is not an
 *    orchestrator, and it is labelled as what it is.
 * 3. **The ids are deterministic and stable**, because a rail whose rows change identity on every
 *    restart cannot hold a selection, and history is the point of this tool.
 *
 * The module is deliberately **pure** — tasks in, runs out, no SQLite. Reading rows is the query
 * layer's job (`tasks.ts`); this is the derivation.
 */

/** More than six hours of silence from one terminal opens a new **wave** of its work. */
export const IDLE_GAP_MS = 6 * 60 * 60 * 1000;

/** The one bucket for tasks Orca never attributed to a terminal. Not an orchestrator's run. */
export const UNATTRIBUTED_RUN_ID = 'run_unattributed';

/** …and the rail says exactly that, rather than dressing the orphans up as an orchestration. */
export const UNATTRIBUTED_LABEL = 'Unattributed';

/** A run is live only while it still has work that could move. */
const IN_FLIGHT: ReadonlySet<string> = new Set<TaskStatus>(['ready', 'dispatched']);

/**
 * A task as the database has it, plus the four things the wire contract deliberately does not
 * carry on a task — and that the derivations built on it cannot work without.
 */
export type TaskWithHandle = {
  /** The task itself. Its `runId` is empty until this module fills it in. */
  task: Task;
  /** `created_by_terminal_handle` — the run key. Null for 4 of 76 live tasks, and pre-v4 Orca has no such column at all. */
  handle: string | null;
  /**
   * `task_title ?? display_name`, or null when Orca never named the task.
   *
   * Not the same thing as `Task.title`: a *task* with no name falls back to its short id, while a
   * *run* with no name falls back to its handle. One chain cannot serve both, and reusing
   * `Task.title` here would silently label a run with a task id.
   */
  name: string | null;
  /**
   * **Every** dispatch attempt this task ever had, oldest first — not `task.dispatch`, which is
   * only the latest.
   *
   * A retry goes to a fresh worktree with a fresh handle, so the first worker's handle exists
   * nowhere else on the wire. The cast is built of all of them (`cast.ts`), message attribution
   * is built of all of them (`attribution.ts`), and the conversation emits one `dispatch` turn per
   * attempt (`conversation.ts`) — because each attempt really was a separate thing the
   * orchestrator did.
   */
  attempts: Dispatch[];
  /** The beginning of `tasks.spec` — what the orchestrator said. Null when the task has none. */
  spec: Preview | null;
  /** The beginning of `tasks.result` — what came back. Null while the task is still working. */
  result: Preview | null;
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
    // One handle, one run. The six-hour gap no longer gets a vote on that — it decides the
    // *waves* inside it, which is a caption on the canvas rather than a row in the rail.
    const run = describeRun(handle, members, orcaIsLive);
    runs.push(run);
    for (const entry of members) runIdOfTask.set(entry.task.id, run.id);
  }

  runs.sort(byMostRecentActivity);

  return {
    runs,
    // Mapped over the entries as they were read, so the creation order the canvas depends on
    // for its isolated-task grid survives the trip through the buckets.
    //
    // The lookup is total by construction: every entry went into exactly one bucket, and every
    // bucket became a run. A fallback here would not be caution — it would hand a task a run id
    // that names no row in the rail, which is a task nothing can ever render.
    tasks: entries.map((entry) => ({ ...entry.task, runId: runIdOfTask.get(entry.task.id)! })),
  };
}

/**
 * The load-bearing step. Everything a terminal created belongs to that terminal, whatever else
 * was happening at the same moment.
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

/** Everything a rail row shows, so the interesting orchestrator can be picked without opening it. */
function describeRun(handle: string | null, members: TaskWithHandle[], orcaIsLive: boolean): Run {
  const ordered = [...members].sort((a, b) => byInstant(a.task.createdAt, b.task.createdAt));
  const first = ordered[0]!;
  const tasks = ordered.map((entry) => entry.task);

  return {
    id: runIdFor(handle),
    handle,
    label: labelFor(handle, first),
    startedAt: first.task.createdAt,
    endedAt: lastActivity(tasks),
    taskCount: tasks.length,
    cast: castOf(handle, ordered),
    waves: wavesOf(handle, ordered),
    statusCounts: countStatuses(tasks),
    // No history mode: yesterday's run renders through this same code path, and the dot is the
    // whole difference. It takes a running Orca *and* work that could still move.
    live: orcaIsLive && tasks.some((task) => IN_FLIGHT.has(task.status)),
    // False here, and true only once the gates have actually been read and their blocking
    // effect derived: they come from `decision_gate` messages and `decision_gates` rows
    // (`gates.ts`), which this module has never seen — it is handed tasks. `attachGates`
    // flips it for the runs a gate really is blocking.
    hasBlockingGates: false,
    edgeCount: countEdges(tasks),
  };
}

/**
 * **The waves** — the six-hour rule, doing its new job (SPEC §4.3).
 *
 * A terminal that goes quiet for more than six hours and then dispatches again did two separate
 * bursts of work, and that is worth seeing. It is *not* worth silently splitting into two rows
 * that claim to be different orchestrators, which is what it used to do.
 *
 * Six hours, and not minutes: a real 13-task run spans 20:10 → 07:04 overnight, and any shorter
 * threshold shreds it into nonsense.
 *
 * The null-handle bucket gets exactly one wave. Those tasks share nothing but the *absence* of a
 * handle — they were never one terminal's work, so a gap between two of them measures nothing,
 * and captioning it "after 14h idle" would be an observation about nobody.
 */
function wavesOf(handle: string | null, ordered: TaskWithHandle[]): Wave[] {
  const segments: TaskWithHandle[][] = [];
  let current: TaskWithHandle[] = [];
  let previous: number | null = null;
  const gaps: (number | null)[] = [];

  for (const entry of ordered) {
    const createdAt = instantOf(entry.task.createdAt);
    const gap = previous !== null && createdAt !== null ? createdAt - previous : null;

    // Strictly *more* than six hours: work that paused for exactly six is still the same wave.
    //
    // And a gap is only a gap between two instants we can actually read. A task whose `created_at`
    // holds something unparseable sorts to the back of its bucket and joins the wave it is beside —
    // opening a new one on a bad column would caption a gap that nothing measured.
    if (handle !== null && current.length > 0 && gap !== null && gap > IDLE_GAP_MS) {
      segments.push(current);
      gaps.push(gap);
      current = [];
    }

    current.push(entry);
    if (createdAt !== null) previous = createdAt;
  }
  if (current.length > 0) segments.push(current);

  return segments.map((segment, index) => ({
    index: index + 1,
    startedAt: segment[0]!.task.createdAt,
    endedAt: lastActivity(segment.map((entry) => entry.task)),
    taskIds: segment.map((entry) => entry.task.id),
    // Null on the first wave — there is nothing in front of it to have been quiet for.
    idleGapBeforeMs: index === 0 ? null : (gaps[index - 1] ?? null),
  }));
}

/**
 * `run_<handle>` — the handle, and nothing else.
 *
 * It used to carry the epoch seconds of the run's first task, which the six-hour split made
 * necessary: one handle could own several runs, and they needed telling apart. One handle is now
 * one run, so the suffix has nothing left to disambiguate — and it was a liability, because it
 * keyed a row's identity on a *task*, and a rail row that changes identity is a selection the
 * user loses.
 *
 * The whole handle, not its first eight hex: this string is a React key and a join, never a label
 * (the rail shows the short handle, and the full one rides in the tooltip). Two terminals sharing
 * a prefix is vanishingly unlikely and would silently merge two orchestrators into one row —
 * which is a lie, and a lie that costs nothing to make impossible.
 */
function runIdFor(handle: string | null): string {
  return handle === null ? UNATTRIBUTED_RUN_ID : `run_${handle}`;
}

/**
 * What the orchestrator was trying to do: the earliest task's title, then its display name, then
 * the terminal that ran it. In practice a run's first task names the work.
 */
function labelFor(handle: string | null, first: TaskWithHandle): string {
  if (handle === null) return UNATTRIBUTED_LABEL;
  return first.name ?? shortHandle(handle);
}

/**
 * When it last did anything — the max of every completion and every creation, which is what the
 * rail sorts on. A run's last task can outlive the last task it *started*.
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
 * The breakdown the rail shows ("6 done / 1 failed"). The six known statuses are always present,
 * at zero when the run has none of them; a status this build has never heard of is counted under
 * its own raw name rather than dropped — a task missing from the tally is a task the rail lies
 * about (SPEC §5).
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
 * The dependency edges *inside* this run — `0` is the edgeless empty state, and 4 of 13 real runs
 * are edgeless.
 *
 * A dep naming a task in another run, or one an `orchestration reset` deleted, is not an edge:
 * there are no foreign keys here (SPEC §4.2, trap 8), and the canvas cannot draw a line to a node
 * that is not on it. Counting one would promise a DAG the user never gets.
 */
function countEdges(tasks: Task[]): number {
  const inRun = new Set(tasks.map((task) => task.id));

  // Distinct deps: the column is an unvalidated JSON array, and a task listing the same
  // dependency twice is still one line on the canvas. Counting it twice would keep a run out of
  // the edgeless state over an edge nobody can see.
  return tasks.reduce(
    (total, task) => total + [...new Set(task.deps)].filter((dep) => inRun.has(dep)).length,
    0
  );
}

/** The rail sorts by most-recent activity, so the run worth opening is the one on top. */
function byMostRecentActivity(a: Run, b: Run): number {
  return byInstant(b.endedAt, a.endedAt) || byInstant(b.startedAt, a.startedAt);
}

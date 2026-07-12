import type { Run, Task } from '../shared/types.ts';
import { IDLE_GAP_MS } from './runs.ts';
import { instantOf } from './time.ts';

/**
 * Which run a message belongs to (SPEC §4.4) — and, just as importantly, when to admit that
 * nothing in the schema says.
 *
 * The feed is scoped to one run. So every message needs a run, and the schema records none:
 * `messages` has no `task_id` column, no run id, and **no foreign keys at all**. What it has
 * is two signals of unequal strength, and this module is the order they are trusted in.
 *
 * 1. **`payload.taskId`, when it names a task that still exists.** It carries 83% of the
 *    traffic (100% of heartbeats and `worker_done`), and it is not a guess — the writer said
 *    which task it meant. It wins outright.
 * 2. **Otherwise the handles, inside the run's time window.** A run's handle set is the
 *    terminal that created its tasks plus every terminal ever dispatched one of them. A
 *    message between two terminals, one of which was working this run at the time, is that
 *    run's message.
 * 3. **Otherwise null.** Including — and this is the point — when *two* runs still match. An
 *    unattributed message shows in the "All" scope and nowhere else. It is never guessed into
 *    a run, because a message in the wrong run is a lie the user cannot see through, while a
 *    message in "All" is merely one they have to go and look for.
 *
 * The window is `[startedAt, endedAt + IDLE_GAP_MS]`, and the tail matters as much as the
 * head. A live run's `endedAt` is its *last task's creation* — nothing has completed yet — so
 * every message a running orchestration sends arrives after it. A window clamped hard to
 * `endedAt` would leave the live case, the one the feed exists for, entirely unattributed.
 * The grace is the same six hours that segment runs in the first place (`runs.ts`): it is
 * already this tool's answer to "how long can one terminal go quiet and still be the same
 * run", and inventing a second constant for the same question would be inventing a second
 * answer to it.
 */

/** What a message row can offer about where it belongs. Everything else about it is text. */
export type MessageOrigin = {
  /** `payload.taskId`, verbatim — it may name a task an `orchestration reset` has deleted. */
  taskId: string | null;
  fromHandle: string | null;
  toHandle: string | null;
  /** ISO — or whatever unreadable thing the column held, in which case no window contains it. */
  createdAt: string;
};

/** The two fields of `FeedMessage` this module exists to fill. */
export type Attributed = {
  /** The task the message names, when it still exists. A dangling reference resolves to null. */
  taskId: string | null;
  runId: string | null;
};

/** Every handle that ever worked a task, keyed by task id — the run handle set is built of these. */
export type AssigneesOfTask = ReadonlyMap<string, readonly string[]>;

type Window = { runId: string; from: number; to: number };

export class Attribution {
  /** Rule 1: the task a message names → the run it was inferred into. */
  private readonly runOfTask: ReadonlyMap<string, string>;
  /** Rule 2: a handle → every run it was part of, each with the window it was part of it in. */
  private readonly windowsOfHandle: ReadonlyMap<string, Window[]>;

  constructor(runOfTask: ReadonlyMap<string, string>, windowsOfHandle: ReadonlyMap<string, Window[]>) {
    this.runOfTask = runOfTask;
    this.windowsOfHandle = windowsOfHandle;
  }

  attribute(message: MessageOrigin): Attributed {
    // A `taskId` naming a task that is gone is a broken link, not a broken row (SPEC §4.2,
    // trap 8): the message keeps its place in the feed and loses its link to a node. What it
    // does *not* do is lose its run — the handles still know which orchestration was talking,
    // and the window still knows when. So it falls through to rule 2 exactly like a message
    // that never named a task at all.
    const taskId = message.taskId !== null && this.runOfTask.has(message.taskId) ? message.taskId : null;
    if (taskId !== null) return { taskId, runId: this.runOfTask.get(taskId)! };

    return { taskId: null, runId: this.runOfMessage(message) };
  }

  /** Rule 2, and rule 3 in its last line: one match is an answer, two are a confession. */
  private runOfMessage({ fromHandle, toHandle, createdAt }: MessageOrigin): string | null {
    const at = instantOf(createdAt);
    if (at === null) return null; // A timestamp nobody can read is in no window.

    const matched = new Set<string>();

    for (const handle of [fromHandle, toHandle]) {
      if (handle === null) continue;
      for (const window of this.windowsOfHandle.get(handle) ?? []) {
        if (at >= window.from && at <= window.to) matched.add(window.runId);
      }
    }

    // Two runs shared a terminal and were both under way. Nothing in the schema distinguishes
    // them, so nothing here pretends to.
    return matched.size === 1 ? [...matched][0]! : null;
  }
}

/**
 * Build the index once per snapshot, from what the run inference has already worked out.
 *
 * `tasks` carry the run they were inferred into; `assignees` carries the handles that worked
 * each of them — *every* attempt's, not just the latest, because a retry is re-dispatched to a
 * fresh worktree with a fresh terminal handle, and the first worker's messages are exactly the
 * ones a post-mortem is looking for.
 */
export function buildAttribution(runs: Run[], tasks: Task[], assignees: AssigneesOfTask): Attribution {
  const runOfTask = new Map(tasks.map((task) => [task.id, task.runId]));
  const windows = new Map(runs.map((run) => [run.id, windowOf(run)]));
  const windowsOfHandle = new Map<string, Window[]>();

  const add = (handle: string | null, runId: string): void => {
    if (handle === null) return;
    const window = windows.get(runId);
    if (window === undefined) return;

    const existing = windowsOfHandle.get(handle);
    if (existing) {
      if (!existing.some((other) => other.runId === runId)) existing.push(window);
    } else {
      windowsOfHandle.set(handle, [window]);
    }
  };

  // The terminal that created the run's tasks. `run_unattributed` has none — those tasks are
  // in it *because* Orca never named one — so it is reachable through its assignees only.
  for (const run of runs) add(run.handle, run.id);

  // …and every terminal that was ever dispatched one of its tasks.
  for (const task of tasks) {
    for (const assignee of assignees.get(task.id) ?? []) add(assignee, task.runId);
  }

  return new Attribution(runOfTask, windowsOfHandle);
}

function windowOf(run: Run): Window {
  const from = instantOf(run.startedAt);
  const to = instantOf(run.endedAt);

  return {
    runId: run.id,
    // A run whose timestamps are unreadable matches nothing rather than everything: an
    // impossible window is how it stays out of every message's candidate set.
    from: from ?? Number.POSITIVE_INFINITY,
    to: to === null ? Number.NEGATIVE_INFINITY : to + IDLE_GAP_MS,
  };
}

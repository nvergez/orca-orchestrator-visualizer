import type { Task } from '../../shared/types.ts';

/**
 * The critical path (#71, SPEC §12.4): **where the retained duration of a completed run
 * accumulated** — the duration-weighted longest path over its in-run dependency edges.
 *
 * It is derived *here*, on the client, from the selected run's tasks and nothing else. The
 * snapshot already carries everything the analysis needs — the edges (`Task.deps`) and each
 * task's honest duration observation (#66) — and a per-run result computed server-side would
 * grow the unbounded snapshot that SPEC §12.1 says quantitative features must not grow.
 *
 * The rules, each one a refusal to claim more than the rows do:
 *
 * - **A task weighs its completed observation** — the dispatch clock, or the visibly labelled
 *   task-span fallback; the preference between them was settled per task by #66 and is not
 *   re-derived here. No completed observation ⇒ **zero, and still traversable**: missing timing
 *   costs the number, never the dependency it sat on.
 * - **Only edges between tasks the run retains.** There are no foreign keys in this schema
 *   (SPEC §4.2, trap 8); a dep naming a task a reset deleted costs exactly that edge.
 * - **Only for a completed run.** Work that could still move has no *final* critical path —
 *   and that is read off the retained statuses, not off Orca's liveness, in both directions:
 *   a run whose worker died mid-flight never finished, however dead the process is now; and a
 *   run whose every retained task is terminal is complete *per retained evidence*, whatever
 *   the orchestrator does next — if it dispatches again, the next push carries the new task
 *   and this derivation withdraws the claim by recomputing.
 * - **A cycle voids the whole analysis.** The retained shape is not a DAG, and a path picked
 *   around the broken part would claim it is. The caller gets an explicit note to show; this
 *   function never throws and never invents.
 * - **The path is maximal by construction** — it runs source to sink, because a chain always
 *   attaches the best chain upstream of it, weightless or not: a zero-weight task the road
 *   can traverse is a task it does not silently drop. **Equal paths resolve deterministically
 *   by retained task order, then id**, at every choice the walk makes — so an unchanged
 *   database can never highlight two different paths.
 */

export type CriticalPath =
  /** The road: task ids in dependency order, and the retained milliseconds along them. */
  | { kind: 'path'; taskIds: string[]; ms: number }
  /** Something could still move — there is no *final* path to claim yet. */
  | { kind: 'in-flight' }
  /** No in-run dependency edges: no road for a path to take (SPEC §7.5's empty state). */
  | { kind: 'edgeless' }
  /** The retained shape is not a DAG. The canvas owes the reader a sentence, not a guess. */
  | { kind: 'cycle' };

/**
 * The two statuses that cannot move again (HANDOFF.md enums). Everything else — including a
 * status from an Orca this build has never seen — keeps the run in-flight: a *final* path over
 * work in an unreadable state would be a claim about evidence we cannot read.
 */
const TERMINAL: ReadonlySet<string> = new Set(['completed', 'failed']);

/** A chain ending at one task: its retained weight, and the way back. */
type Chain = { ms: number; pred: string | null };

export function criticalPathOf(tasks: readonly Task[]): CriticalPath {
  if (tasks.some((task) => !TERMINAL.has(task.status))) return { kind: 'in-flight' };

  const order = new Map(tasks.map((task, index) => [task.id, index]));
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  const connected = new Set<string>();

  for (const task of tasks) {
    // Distinct deps: the column is an unvalidated JSON array, and the same edge written twice
    // would otherwise leave a phantom indegree behind — turning one honest edge into a "cycle".
    for (const dep of new Set(task.deps)) {
      if (!order.has(dep)) continue; // The miss costs one edge, never a node (trap 8).
      push(preds, task.id, dep);
      push(succs, dep, task.id);
      connected.add(dep);
      connected.add(task.id);
    }
  }

  if (connected.size === 0) return { kind: 'edgeless' };

  // Kahn's walk over the connected tasks. Falling short of all of them means some edge loops —
  // a self-dependency included — and a non-DAG shape omits the result rather than breaking it.
  const sorted = topologically(tasks, connected, preds, succs);
  if (sorted.length < connected.size) return { kind: 'cycle' };

  const weight = new Map(tasks.map((task) => [task.id, weightOf(task)]));

  const best = new Map<string, Chain>();

  /**
   * The deterministic choice, made the same way everywhere this function chooses: heavier
   * retained duration first, then **retained task order, then id** — the tie-break SPEC §12.4
   * pins, applied to the upstream chain a task attaches and to the sink the path ends at.
   */
  const beats = (a: string, b: string): boolean => {
    const ca = best.get(a)!;
    const cb = best.get(b)!;
    if (ca.ms !== cb.ms) return ca.ms > cb.ms;
    if (order.get(a) !== order.get(b)) return order.get(a)! < order.get(b)!;
    return a < b;
  };

  for (const id of sorted) {
    // A chain with any upstream at all attaches the best of it — a weightless predecessor
    // included, or the road would quietly start downstream of tasks it can traverse.
    let into: string | null = null;
    for (const candidate of preds.get(id) ?? []) {
      if (into === null || beats(candidate, into)) into = candidate;
    }

    best.set(id, { ms: weight.get(id)! + (into === null ? 0 : best.get(into)!.ms), pred: into });
  }

  // The path ends at a **sink** — weights are never negative, so no sink's chain is lighter
  // than anything upstream of it, and ending anywhere else would truncate the retained road
  // for no weight at all.
  let end: string | null = null;
  for (const task of tasks) {
    if (!connected.has(task.id) || succs.has(task.id)) continue;
    if (end === null || beats(task.id, end)) end = task.id;
  }

  const taskIds: string[] = [];
  for (let id: string | null = end; id !== null; id = best.get(id)!.pred) taskIds.push(id);
  taskIds.reverse();

  return { kind: 'path', taskIds, ms: best.get(end!)!.ms };
}

/**
 * What one task adds to a path: its completed observation's milliseconds, whichever clock #66
 * put on it. An absent, still-open, or contradictory observation weighs **zero** — never an
 * invented number, and never a hole in the graph.
 */
function weightOf(task: Task): number {
  const observation = task.duration;
  if (!observation?.complete) return 0;

  // The server derives `ms` from the endpoints it rides with and never sends a negative one —
  // so a missing or negative value here is a wire this client did not expect, and it weighs
  // nothing rather than eating the path's total.
  const ms = observation.ms ?? 0;
  return ms > 0 ? ms : 0;
}

/**
 * Kahn's algorithm over the connected tasks, seeded and grown in retained task order — not for
 * correctness (the choice below depends only on predecessors being finished first) but so the
 * walk itself is as deterministic as the answer it feeds.
 */
function topologically(
  tasks: readonly Task[],
  connected: ReadonlySet<string>,
  preds: ReadonlyMap<string, string[]>,
  succs: ReadonlyMap<string, string[]>
): string[] {
  const indegree = new Map<string, number>();
  for (const id of connected) indegree.set(id, preds.get(id)?.length ?? 0);

  const sorted = tasks.filter((task) => indegree.get(task.id) === 0).map((task) => task.id);

  for (let head = 0; head < sorted.length; head++) {
    for (const next of succs.get(sorted[head]!) ?? []) {
      const left = indegree.get(next)! - 1;
      indegree.set(next, left);
      if (left === 0) sorted.push(next);
    }
  }

  return sorted;
}

function push(edges: Map<string, string[]>, key: string, value: string): void {
  const list = edges.get(key);
  if (list) list.push(value);
  else edges.set(key, [value]);
}

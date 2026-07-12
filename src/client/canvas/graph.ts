import type { Task } from '../../shared/types.ts';

/**
 * The shape of the work: which tasks the DAG draws, which hang off nothing, and the edges
 * between them. How any of it *looks* is `theme.ts`.
 */

export type Edge = { id: string; source: string; target: string };

export type Graph = {
  /** Tasks the layered layout draws: everything an edge touches. */
  connected: Task[];
  /** Everything else, grid-packed below in creation order — dispatch order is all they have. */
  isolated: Task[];
  edges: Edge[];
};

/**
 * Split the task set into the DAG and the singletons.
 *
 * About 50 of 76 live tasks are fully isolated. Left in the layered graph they become a
 * 50-node-wide rank-0 ribbon that `fitView` zooms out until nothing is legible — so they
 * come out and get packed into a grid of their own (SPEC §7.5).
 *
 * A dep whose task is not in the set is dropped: there are no foreign keys in this schema,
 * and a reset leaves `deps` pointing at tasks that no longer exist (SPEC §4.2, trap 8). The
 * miss costs one edge, never the node.
 */
export function buildGraph(tasks: Task[]): Graph {
  const known = new Set(tasks.map((task) => task.id));
  const edges: Edge[] = [];
  const touched = new Set<string>();

  for (const task of tasks) {
    for (const dep of task.deps) {
      if (!known.has(dep)) continue;
      edges.push({ id: `${dep}->${task.id}`, source: dep, target: task.id });
      touched.add(dep);
      touched.add(task.id);
    }
  }

  return {
    connected: tasks.filter((task) => touched.has(task.id)),
    // `tasks` arrives in creation order from the server, and filtering preserves it.
    isolated: tasks.filter((task) => !touched.has(task.id)),
    edges,
  };
}

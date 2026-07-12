import type { Task } from '../../shared/types.ts';

/**
 * The canvas' vocabulary: the task's colour, its badges, and the split between the DAG and
 * the singletons hanging off nothing.
 *
 * Locked against the prototype the dev signed off on screen (`prototype/src/`, SPEC §7.5) —
 * the numbers and the colours below are that approval, transcribed.
 */

/** 240 × 84, title clamped to three lines. Nothing is hidden behind a hover (SPEC §7.5). */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 84;

/**
 * How quiet an agent has to go before its "last seen" badge turns amber.
 *
 * 2× the 5-minute heartbeat cadence Orca instructs its workers to keep — one missed beat is
 * noise, two is a worker that has stopped talking. A constant, because a magic number here
 * is a magic number about *when to worry*.
 */
export const STALE_HEARTBEAT_MS = 10 * 60 * 1000;

export type StatusColor = { bg: string; border: string; text: string };

/** Verbatim from the approved prototype (SPEC §7.5). Do not retune without re-approval. */
export const STATUS_COLORS: Record<string, StatusColor> = {
  pending: { bg: '#f4f4f5', border: '#a1a1aa', text: '#3f3f46' },
  ready: { bg: '#dbeafe', border: '#3b82f6', text: '#1e3a8a' },
  dispatched: { bg: '#fef3c7', border: '#f59e0b', text: '#78350f' },
  completed: { bg: '#dcfce7', border: '#22c55e', text: '#14532d' },
  failed: { bg: '#fee2e2', border: '#ef4444', text: '#7f1d1d' },
  blocked: { bg: '#f3e8ff', border: '#a855f7', text: '#581c87' },
};

/**
 * A status from an Orca newer than this build. Neutral grey, and the raw string is the chip
 * label — the task is *shown*, in a colour that claims nothing (SPEC §5).
 */
export const UNKNOWN_STATUS_COLOR: StatusColor = { bg: '#e4e4e7', border: '#71717a', text: '#27272a' };

export function colorOf(status: string): StatusColor {
  return STATUS_COLORS[status] ?? UNKNOWN_STATUS_COLOR;
}

export function isKnownStatus(status: string): boolean {
  return status in STATUS_COLORS;
}

/** `term_9f8e7d6c-…` → `9f8e7d6c`: the first 8 hex of the handle (SPEC §7.5). */
export function shortHandle(handle: string): string {
  return handle.replace(/^term_/, '').slice(0, 8);
}

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

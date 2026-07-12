import ELK from 'elkjs/lib/elk.bundled.js';
import type { Task } from '../../shared/types.ts';
import { type Edge, type Graph, NODE_HEIGHT, NODE_WIDTH } from './graph.ts';

/**
 * Where the nodes go: elkjs for the DAG, a grid for the singletons (SPEC §7.5).
 *
 * elkjs rather than dagre for one reason — **disconnected components**. Naive dagre puts
 * every isolated node in rank 0 and produces a ~50-node-wide ribbon. elkjs separates
 * components natively, and the singletons we pull out ourselves are packed below the graph
 * in creation order, because for an edgeless run dispatch order is the only structure there
 * is to show.
 */

const elk = new ELK();

/** Locked (SPEC §7.5): layered, top-to-bottom, components kept apart. */
const LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.separateConnectedComponents': 'true',
  'elk.layered.spacing.nodeNodeBetweenLayers': '70',
  'elk.spacing.nodeNode': '30',
  'elk.spacing.componentComponent': '60',
};

const GRID_GAP = 24;
/** Clear air between the DAG and the grid below it, so the two blocks read as two blocks. */
const GRID_TOP_MARGIN = 120;

export type Placement = { id: string; x: number; y: number };

export async function layoutGraph({ connected, isolated, edges }: Graph): Promise<Placement[]> {
  const placed = await layerDag(connected, edges);
  return [...placed, ...packGrid(isolated, boundsOf(placed))];
}

async function layerDag(connected: Task[], edges: Edge[]): Promise<Placement[]> {
  if (connected.length === 0) return [];

  const laid = await elk.layout({
    id: 'root',
    layoutOptions: LAYOUT_OPTIONS,
    children: connected.map((task) => ({ id: task.id, width: NODE_WIDTH, height: NODE_HEIGHT })),
    edges: edges.map((edge) => ({ id: edge.id, sources: [edge.source], targets: [edge.target] })),
  });

  return (laid.children ?? []).map((child) => ({ id: child.id, x: child.x ?? 0, y: child.y ?? 0 }));
}

/**
 * The isolated block: a grid under the DAG, filled left to right in **creation order**.
 *
 * Roughly twice as wide as it is tall, which is the shape that reads as a block rather than
 * a column or a ribbon.
 */
function packGrid(isolated: Task[], bounds: { left: number; bottom: number }): Placement[] {
  const columns = Math.max(4, Math.ceil(Math.sqrt(isolated.length * 2)));

  return isolated.map((task, index) => ({
    id: task.id,
    x: bounds.left + (index % columns) * (NODE_WIDTH + GRID_GAP),
    y: bounds.bottom + GRID_TOP_MARGIN + Math.floor(index / columns) * (NODE_HEIGHT + GRID_GAP),
  }));
}

function boundsOf(placed: Placement[]): { left: number; bottom: number } {
  if (placed.length === 0) return { left: 0, bottom: 0 };
  return {
    left: Math.min(...placed.map((node) => node.x)),
    bottom: Math.max(...placed.map((node) => node.y + NODE_HEIGHT)),
  };
}

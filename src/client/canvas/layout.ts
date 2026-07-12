import ELK from 'elkjs/lib/elk.bundled.js';
import type { Task, Wave } from '../../shared/types.ts';
import type { Edge, Graph } from './graph.ts';
import { NODE_HEIGHT, NODE_WIDTH } from './theme.ts';

/**
 * Where the nodes go: elkjs for the DAG, a grid for the singletons, and **one block per wave**
 * (SPEC §7.5).
 *
 * elkjs rather than dagre for one reason — **disconnected components**. Naive dagre puts every
 * isolated node in rank 0 and produces a ~50-node-wide ribbon. elkjs separates components
 * natively, and the singletons we pull out ourselves are packed below the graph in creation order,
 * because for an edgeless run dispatch order is the only structure there is to show.
 *
 * **The waves are why the layout is partitioned and not merely captioned.** A wave is a burst of
 * an orchestrator's work with more than six idle hours in front of it (`server/runs.ts`), and the
 * canvas draws it as a bordered region — which it can only honestly do if the region *is* a
 * region. elkjs lays a graph out by its **dependencies**; ask it to lay out both waves at once and
 * their nodes interleave wherever the DAG says they should, so a "wave 2" border drawn round the
 * resulting scatter would be a border round the whole canvas. So each wave is laid out on its own
 * and the blocks are set down side by side, left to right, in time order — which is the axis a
 * wave actually means.
 *
 * A dependency that crosses from one wave into the next still draws: React Flow joins two nodes
 * wherever they are, and a long edge between two blocks is exactly what "the work we picked up
 * again 14 hours later depended on the work we stopped in the middle of" looks like.
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

/** The breathing room inside a wave's border, and the field between one wave and the next. */
const WAVE_PADDING = 34;
const WAVE_GAP = 72;

export type Placement = { id: string; x: number; y: number };

/** A wave's region on the canvas — the bordered box the nodes of one burst of work sit inside. */
export type WaveBox = { wave: Wave; x: number; y: number; width: number; height: number };

export type Layout = {
  placements: Placement[];
  /**
   * Empty when the orchestrator worked in **one** wave, which most of them did.
   *
   * A single box drawn round the whole canvas says nothing. The only thing a wave border can mean
   * is *this is where one burst of work stopped and the next one started* — so the regions appear
   * exactly when there is a gap to point at, and never as furniture.
   */
  boxes: WaveBox[];
};

export async function layoutGraph(graph: Graph, waves: Wave[]): Promise<Layout> {
  const groups = partition(graph, waves);

  const placements: Placement[] = [];
  const boxes: WaveBox[] = [];
  let offsetX = 0;

  for (const group of groups) {
    const laid = await layoutOne(graph, group.taskIds);
    if (laid.length === 0) continue;

    const bounds = boundsOf(laid);
    // elk lays every graph out near its own origin, so without this each wave would be drawn on
    // top of the last. Shifting by the block's own left edge is what makes `offsetX` mean what it
    // says: the field between this wave and the one before it.
    const shift = offsetX + WAVE_PADDING - bounds.left;

    for (const placement of laid) placements.push({ ...placement, x: placement.x + shift, y: placement.y });

    const width = bounds.right - bounds.left + WAVE_PADDING * 2;

    if (groups.length > 1) {
      boxes.push({
        wave: group.wave,
        x: offsetX,
        y: bounds.top - WAVE_PADDING,
        width,
        height: bounds.bottom - bounds.top + WAVE_PADDING * 2,
      });
    }

    offsetX += width + WAVE_GAP;
  }

  return { placements, boxes };
}

/** One wave's tasks, in the order the waves happened. */
type Group = { wave: Wave; taskIds: ReadonlySet<string> };

/**
 * Which tasks belong to which wave.
 *
 * The server decides this and the client trusts it — but it trusts it **defensively**, because a
 * task id is a soft string everywhere it appears and this schema has no foreign keys at all (SPEC
 * §4.2, trap 8). A task the waves somehow fail to name joins the first one rather than being
 * dropped: an unplaced node is a node that vanishes off the canvas, and losing a task is the one
 * thing this tool must never do.
 */
function partition(graph: Graph, waves: Wave[]): Group[] {
  const all = [...graph.connected, ...graph.isolated].map((task) => task.id);
  const named = new Set(waves.flatMap((wave) => wave.taskIds));
  const orphans = all.filter((id) => !named.has(id));

  // A run with no waves at all is not a shape the server produces. A client that rendered a blank
  // canvas if it ever did would be one bad column away from looking broken.
  if (waves.length === 0) {
    return [{ wave: { index: 1, startedAt: '', endedAt: '', taskIds: all, idleGapBeforeMs: null }, taskIds: new Set(all) }];
  }

  return waves
    .map((wave, index) => ({
      wave,
      taskIds: new Set(index === 0 ? [...wave.taskIds, ...orphans] : wave.taskIds),
    }))
    .filter((group) => group.taskIds.size > 0);
}

/** One wave: its own DAG through elk, then its own singletons grid-packed underneath. */
async function layoutOne(graph: Graph, taskIds: ReadonlySet<string>): Promise<Placement[]> {
  const inWave = (task: Task): boolean => taskIds.has(task.id);

  const connected = graph.connected.filter(inWave);
  const isolated = graph.isolated.filter(inWave);
  // Only the edges with *both* ends inside this wave. One that leaves it is still drawn — React
  // Flow needs two nodes, not a layout — but it is not elk's to route through a block it crosses.
  const edges = graph.edges.filter((edge) => taskIds.has(edge.source) && taskIds.has(edge.target));

  const placed = await layerDag(connected, edges);
  const dag = boundsOf(placed);

  // The grid hangs below the DAG — unless there is no DAG, in which case it *is* the wave and has
  // nothing to hang below. 4 of 13 real runs are entirely edgeless (SPEC §7.5), so this is not the
  // corner case it looks like.
  const top = placed.length === 0 ? 0 : dag.bottom + GRID_TOP_MARGIN;

  return [...placed, ...packGrid(isolated, dag.left, top)];
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
 * Roughly twice as wide as it is tall, which is the shape that reads as a block rather than a
 * column or a ribbon.
 */
function packGrid(isolated: Task[], left: number, top: number): Placement[] {
  if (isolated.length === 0) return [];

  const columns = Math.max(4, Math.ceil(Math.sqrt(isolated.length * 2)));

  return isolated.map((task, index) => ({
    id: task.id,
    x: left + (index % columns) * (NODE_WIDTH + GRID_GAP),
    y: top + Math.floor(index / columns) * (NODE_HEIGHT + GRID_GAP),
  }));
}

type Bounds = { left: number; right: number; top: number; bottom: number };

function boundsOf(placed: Placement[]): Bounds {
  if (placed.length === 0) return { left: 0, right: 0, top: 0, bottom: 0 };

  return {
    left: Math.min(...placed.map((node) => node.x)),
    right: Math.max(...placed.map((node) => node.x + NODE_WIDTH)),
    top: Math.min(...placed.map((node) => node.y)),
    bottom: Math.max(...placed.map((node) => node.y + NODE_HEIGHT)),
  };
}

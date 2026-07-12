import {
  Background,
  BackgroundVariant,
  Controls,
  type Edge as FlowEdge,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronDown, ChevronRight, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Task } from '../../shared/types.ts';
import type { Pulse } from '../feed/theme.ts';
import { PANEL_CLASS } from '../surface.ts';
import { buildGraph, type Edge, type Graph } from './graph.ts';
import { layoutGraph, type Placement } from './layout.ts';
import { TaskNode, type TaskFlowNode } from './TaskNode.tsx';
import { isAlive, NODE_HEIGHT, NODE_WIDTH, themeOf } from './theme.ts';

/**
 * The DAG — one run of it (#16), because every task in the database as one graph is 76 nodes of
 * unreadable soup, and the rail is what resolves it.
 *
 * Two shapes the real data insists on:
 *
 * - **The singletons.** ~50 of 76 tasks touch no edge. They are pulled out of the layered
 *   layout and packed into a collapsible grid below it, in creation order.
 * - **The edgeless task set.** 4 of 13 real runs have no dependencies at all. It gets the
 *   grid and a one-liner that describes the orchestration honestly, rather than an empty
 *   canvas that looks broken (SPEC §7.5).
 *
 * The canvas is a **panel on the field** (SPEC §7.9): opaque, where the rail and the dock beside it
 * are glass. It is the one surface here you are meant to look *into* rather than at, and a
 * translucent workspace with the page's own grid showing through it would be two grids.
 */

const NODE_TYPES = { task: TaskNode };

/** The floating chrome inside the canvas — the isolated toggle, the edgeless note. Glass, lifted. */
const CANVAS_CHIP_CLASS = 'bg-panel border-panel-border shadow-lift-2 rounded-full border backdrop-blur-xl';

export type CanvasProps = {
  tasks: Task[];
  /** The task the feed pointed at, or the one that was clicked. Outlined, and centred. */
  selectedTaskId: string | null;
  /** Clicking a node is the other direction of the link: it filters the feed to that task. */
  onSelectTask: (taskId: string) => void;
  /** Nodes a message has just landed on, in that message type's colour (#18). */
  pulses: ReadonlyMap<string, Pulse>;
};

export function Canvas({ tasks, selectedTaskId, onSelectTask, pulses }: CanvasProps) {
  const graph = useMemo(() => buildGraph(tasks), [tasks]);
  const [laidOut, setLaidOut] = useState<{ graph: Graph; placements: Placement[] } | null>(null);
  const [showIsolated, setShowIsolated] = useState(true);

  useEffect(() => {
    let current = true;
    // elkjs is async. Nodes are drawn once they have somewhere to be — a canvas of
    // overlapping nodes at (0, 0) for a frame is worse than a canvas that arrives whole.
    void layoutGraph(graph).then((placements) => {
      if (current) setLaidOut({ graph, placements });
    });
    return () => {
      current = false;
    };
  }, [graph]);

  // A layout belongs to the graph it was computed for. Holding on to the graph rather than
  // clearing the placements is what keeps a stale layout off a canvas whose tasks changed.
  const placements = laidOut?.graph === graph ? laidOut.placements : null;

  const nodes = useMemo(
    () => (placements ? toNodes(graph, placements, showIsolated, selectedTaskId, pulses) : []),
    [graph, placements, showIsolated, selectedTaskId, pulses]
  );

  const edges = useMemo(() => toEdges(graph.edges, tasks), [graph.edges, tasks]);

  if (tasks.length === 0) {
    return (
      <Empty>
        <p role="status" className="max-w-sm text-balance">
          No tasks in this database yet — nothing has been dispatched.
        </p>
      </Empty>
    );
  }

  if (!placements) {
    return (
      <Empty>
        <p role="status" className="max-w-sm text-balance">
          Laying out {tasks.length} tasks…
        </p>
      </Empty>
    );
  }

  return (
    <section data-testid="canvas" className={cn(PANEL_CLASS, 'bg-panel-solid h-full w-full overflow-hidden')}>
      <ReactFlow<TaskFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        // A one-task run must not blow that task up to fill a 1600px canvas: fitting *to* the
        // graph is the point, magnifying it is not. Zooming in past 1:1 is still yours to do.
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.05}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, node) => onSelectTask(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap<TaskFlowNode>
          pannable
          zoomable
          nodeColor={(node) => themeOf(node.data.task.status).accent}
          nodeBorderRadius={3}
        />

        {/* Inside `<ReactFlow>`, because that is where its viewport context lives. */}
        <CentreOnSelection selectedTaskId={selectedTaskId} nodes={nodes} />

        {graph.edges.length === 0 && (
          <Panel position="top-center">
            <p data-testid="edgeless-note" className={cn(CANVAS_CHIP_CLASS, 'text-muted-foreground px-3.5 py-1.5 text-xs')}>
              No dependencies in this run — {tasks.length} tasks dispatched independently.
            </p>
          </Panel>
        )}

        {graph.isolated.length > 0 && (
          <Panel position="top-left">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowIsolated((shown) => !shown)}
              aria-expanded={showIsolated}
              className={cn(CANVAS_CHIP_CLASS, 'hover:bg-accent h-7 gap-1 px-3 text-xs')}
            >
              {showIsolated ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Isolated tasks ({graph.isolated.length})
            </Button>
          </Panel>
        )}
      </ReactFlow>
    </section>
  );
}

/**
 * The canvas with nothing to draw on it: still the canvas, and still says why.
 *
 * It keeps the panel and the grid — an empty *workspace* is what this is, and a bare sentence
 * floating on the page would read as a screen that failed to load rather than a run with no
 * tasks in it.
 */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <section
      data-testid="canvas"
      className={cn(
        PANEL_CLASS,
        'bg-panel-solid text-muted-foreground relative flex h-full w-full items-center justify-center overflow-hidden p-6 text-center text-sm'
      )}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle, color-mix(in oklch, var(--muted-foreground) 26%, transparent) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />

      <div className="relative flex flex-col items-center gap-3">
        <span className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-xl">
          <Waypoints className="size-4.5" />
        </span>
        {children}
      </div>
    </section>
  );
}

/**
 * "Click a feed row → its node highlights **and centres**" (SPEC §7.6) — the half of the link
 * that a highlight alone does not deliver. On a 76-node canvas the node you were sent to is
 * usually off screen, and an outline you have to go hunting for is not an answer to *where*.
 *
 * It centres **once per selection**, never on every push: the node data carries a fresh `now`
 * on each tick, so an effect that re-ran with the nodes would drag the viewport back every
 * five seconds and make the canvas impossible to pan away from.
 *
 * It waits for the layout, rather than giving up when it misses. Selecting a row whose task is
 * in *another* run switches runs, and that run's elkjs layout is async — so the node does not
 * exist yet at the moment the selection changes. The effect re-runs when the placements land,
 * and the guard makes the second run the one that centres.
 */
function CentreOnSelection({
  selectedTaskId,
  nodes,
}: {
  selectedTaskId: string | null;
  nodes: TaskFlowNode[];
}) {
  const flow = useReactFlow();
  const centred = useRef<string | null>(null);

  useEffect(() => {
    if (selectedTaskId === null) {
      centred.current = null;
      return;
    }
    if (centred.current === selectedTaskId) return;

    const node = nodes.find((candidate) => candidate.id === selectedTaskId);
    if (!node) return; // Not laid out yet, or not in this run. Try again when the nodes change.

    centred.current = selectedTaskId;
    flow.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_HEIGHT / 2, {
      // The zoom the user chose is theirs. Centring moves the canvas *to* the node; it does
      // not decide how close they wanted to be standing.
      zoom: flow.getZoom(),
      duration: 300,
    });
  }, [selectedTaskId, nodes, flow]);

  return null;
}

/**
 * The isolated block collapses; the DAG does not. 50 disconnected singletons would
 * otherwise flatten the graph into a ribbon nobody can read — but nothing is hidden by
 * *default* (SPEC §7.5), least of all completed work, which is the payload of a post-mortem.
 */
function toNodes(
  graph: Graph,
  placements: Placement[],
  showIsolated: boolean,
  selectedTaskId: string | null,
  pulses: ReadonlyMap<string, Pulse>
): TaskFlowNode[] {
  const at = new Map(placements.map((placement) => [placement.id, placement]));
  const now = Date.now();
  const shown = showIsolated ? [...graph.connected, ...graph.isolated] : graph.connected;

  return shown.map((task, index) => ({
    id: task.id,
    type: 'task' as const,
    position: { x: at.get(task.id)?.x ?? 0, y: at.get(task.id)?.y ?? 0 },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    data: {
      task,
      now,
      selected: task.id === selectedTaskId,
      pulse: pulses.get(task.id) ?? null,
      // The draw order, so the graph resolves top-down rather than all at once (`motion.ts`).
      index,
    },
    draggable: false,
  }));
}

/**
 * Dependency edges — **a status affordance, never message flow** (SPEC §7.6). An edge into
 * a dispatched task is dashed and animated, which is how the canvas shows where work is
 * actually in flight. It is not a message travelling: messages go between *handles*, and
 * animating one along a dep edge would draw a flow that does not exist.
 */
function toEdges(edges: Edge[], tasks: Task[]): FlowEdge[] {
  const status = new Map(tasks.map((task) => [task.id, task.status]));

  return edges.map((edge) => {
    const inFlight = isAlive(status.get(edge.target) ?? '');

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: inFlight,
      style: {
        strokeWidth: inFlight ? 2 : 1.5,
        strokeDasharray: inFlight ? '6 4' : undefined,
        // The one edge with something to say says it in the colour of the thing it is saying:
        // work is in flight into this task, and `dispatched` is what that looks like everywhere
        // else on the page.
        ...(inFlight && { stroke: themeOf('dispatched').accent }),
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    };
  });
}

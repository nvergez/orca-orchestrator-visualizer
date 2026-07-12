import {
  Background,
  Controls,
  type Edge as FlowEdge,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useState } from 'react';
import type { Task } from '../../shared/types.ts';
import { buildGraph, type Edge, type Graph } from './graph.ts';
import { layoutGraph, type Placement } from './layout.ts';
import { TaskNode, type TaskFlowNode } from './TaskNode.tsx';
import { colorOf, NODE_HEIGHT, NODE_WIDTH } from './theme.ts';

/**
 * The DAG.
 *
 * At this ticket it draws **every task in the database as one graph**, which at 76 tasks is
 * an unusable soup. That is expected and honest: it is the tracer that lands the read path,
 * the derivation and the canvas end to end, and it is the thing run scoping (#16) exists to
 * fix. Making it look nicer here would mean inventing run scoping, badly.
 *
 * Two shapes the real data insists on:
 *
 * - **The singletons.** ~50 of 76 tasks touch no edge. They are pulled out of the layered
 *   layout and packed into a collapsible grid below it, in creation order.
 * - **The edgeless task set.** 4 of 13 real runs have no dependencies at all. It gets the
 *   grid and a one-liner that describes the orchestration honestly, rather than an empty
 *   canvas that looks broken (SPEC §7.5).
 */

const NODE_TYPES = { task: TaskNode };

export function Canvas({ tasks }: { tasks: Task[] }) {
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
    () => (placements ? toNodes(graph, placements, showIsolated) : []),
    [graph, placements, showIsolated]
  );

  const edges = useMemo(() => toEdges(graph.edges, tasks), [graph.edges, tasks]);

  if (tasks.length === 0) {
    return (
      <section data-testid="canvas" style={{ padding: 16 }}>
        <p role="status">No tasks in this database yet — nothing has been dispatched.</p>
      </section>
    );
  }

  if (!placements) {
    return (
      <section data-testid="canvas" style={{ padding: 16 }}>
        <p role="status">Laying out {tasks.length} tasks…</p>
      </section>
    );
  }

  return (
    <section data-testid="canvas" style={{ width: '100%', height: '100%' }}>
      <ReactFlow<TaskFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.05}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background />
        <Controls showInteractive={false} />
        <MiniMap<TaskFlowNode> pannable zoomable nodeColor={(node) => colorOf(node.data.task.status).border} />

        {graph.edges.length === 0 && (
          <Panel position="top-center">
            <p data-testid="edgeless-note" style={NOTE_STYLE}>
              No dependencies in this run — {tasks.length} tasks dispatched independently.
            </p>
          </Panel>
        )}

        {graph.isolated.length > 0 && (
          <Panel position="top-left">
            <button
              type="button"
              onClick={() => setShowIsolated((shown) => !shown)}
              aria-expanded={showIsolated}
              style={BUTTON_STYLE}
            >
              {showIsolated ? '▾' : '▸'} Isolated tasks ({graph.isolated.length})
            </button>
          </Panel>
        )}
      </ReactFlow>
    </section>
  );
}

const NOTE_STYLE = {
  margin: 0,
  padding: '6px 12px',
  borderRadius: 6,
  background: '#f4f4f5',
  border: '1px solid #d4d4d8',
  fontSize: 13,
  color: '#3f3f46',
};

const BUTTON_STYLE = {
  padding: '5px 10px',
  borderRadius: 6,
  border: '1px solid #d4d4d8',
  background: '#ffffff',
  fontSize: 12,
  cursor: 'pointer',
};

/**
 * The isolated block collapses; the DAG does not. 50 disconnected singletons would
 * otherwise flatten the graph into a ribbon nobody can read — but nothing is hidden by
 * *default* (SPEC §7.5), least of all completed work, which is the payload of a post-mortem.
 */
function toNodes(graph: Graph, placements: Placement[], showIsolated: boolean): TaskFlowNode[] {
  const at = new Map(placements.map((placement) => [placement.id, placement]));
  const now = Date.now();
  const shown = showIsolated ? [...graph.connected, ...graph.isolated] : graph.connected;

  return shown.map((task) => ({
    id: task.id,
    type: 'task' as const,
    position: { x: at.get(task.id)?.x ?? 0, y: at.get(task.id)?.y ?? 0 },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    data: { task, now },
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
    const inFlight = status.get(edge.target) === 'dispatched';

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: inFlight,
      style: { strokeWidth: 1.5, strokeDasharray: inFlight ? '6 4' : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    };
  });
}

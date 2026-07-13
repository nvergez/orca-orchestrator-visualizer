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
  useStore,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ChevronDown, ChevronRight, Waypoints } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CastMember, Task, Wave } from '../../shared/types.ts';
import type { Pulse } from '../conversation/theme.ts';
import { useNow } from '../relative-time.ts';
import { useIsMobile } from '../viewport.tsx';
import { hasCurrentActivityEvidence, taskWorkerHealth } from '../worker-health.ts';
import { PANEL_CLASS } from '../surface.ts';
import { buildGraph, type Edge, type Graph } from './graph.ts';
import { layoutGraph, type Layout, type WaveBox } from './layout.ts';
import { TaskNode, type TaskFlowNode } from './TaskNode.tsx';
import { agentOf, NODE_HEIGHT, NODE_WIDTH, themeOf } from './theme.ts';
import { WaveRegion, type WaveFlowNode } from './WaveRegion.tsx';

/**
 * The DAG — one orchestrator's, because every task in the database as one graph is 76 nodes of
 * unreadable soup, and the rail is what resolves it.
 *
 * Three shapes the real data insists on:
 *
 * - **The singletons.** ~50 of 76 tasks touch no edge. They are pulled out of the layered layout
 *   and packed into a collapsible grid below it, in creation order.
 * - **The edgeless task set.** 4 of 13 real runs have no dependencies at all. It gets the grid and
 *   a one-liner that describes the orchestration honestly, rather than an empty canvas that looks
 *   broken (SPEC §7.5).
 * - **The waves.** One terminal, reused across four days, is **one** orchestrator — and the bursts
 *   of work inside it are drawn as bordered regions with the idle gap that opened each one written
 *   on the border (`WaveRegion.tsx`, SPEC §4.3).
 *
 * **And it dims.** Selecting an agent in the rail fades every node that is not theirs — the tool's
 * central gesture, and the reason the canvas takes a cast at all. Faded, never hidden: the shape of
 * the orchestration survives the filter, so you can see *where* your agent's work sat inside it.
 *
 * The canvas is a **panel on the field** (SPEC §7.9): opaque, where the rail and the dock beside it
 * are glass. It is the one surface here you are meant to look *into* rather than at.
 */

const NODE_TYPES = { task: TaskNode, wave: WaveRegion };

/** The floating chrome inside the canvas — the isolated toggle, the edgeless note. Glass, lifted. */
const CANVAS_CHIP_CLASS = 'bg-panel border-panel-border shadow-lift-2 rounded-full border backdrop-blur-xl';

const NO_CAST: CastMember[] = [];
const NO_WAVES: Wave[] = [];

export type CanvasProps = {
  tasks: Task[];
  /** The orchestrator's agents — the node's stripe and monogram are an index into this (`theme.ts`). */
  cast?: CastMember[];
  /** Its bursts of work, drawn as regions when there is more than one. */
  waves?: Wave[];
  /** The agent the rail has selected. Everything that is not theirs dims. Null ⇒ nothing dims. */
  selectedAgent?: string | null;
  /** The task the conversation pointed at, or the one that was clicked. Outlined, and centred. */
  selectedTaskId: string | null;
  /** Clicking a node is the other direction of the link: it opens that task's story. */
  onSelectTask: (taskId: string) => void;
  /** Nodes a message has just landed on, in that message type's colour (SPEC §7.6). */
  pulses: ReadonlyMap<string, Pulse>;
  /**
   * Incremented by the folded shell when the dock band collapses after a cross-run hop — the
   * one moment a fresh fit ran against a canvas the band was still holding most of, and the
   * only re-frame the canvas cannot detect for itself (`Refit`, below). Desktop never
   * increments it, so the default keeps the signed-off layout inert.
   */
  refitSignal?: number;
};

type LayoutInput = {
  key: string;
  graph: Graph;
  waves: Wave[];
  tasks: Task[];
};

type ReadyLayout = LayoutInput & { layout: Layout };

export function Canvas({
  tasks,
  cast = NO_CAST,
  waves = NO_WAVES,
  selectedAgent = null,
  selectedTaskId,
  onSelectTask,
  pulses,
  refitSignal = 0,
}: CanvasProps) {
  const graph = useMemo(() => buildGraph(tasks), [tasks]);
  const layoutKey = useMemo(() => layoutKeyOf(graph, waves), [graph, waves]);
  const layoutInput = useRef<LayoutInput>({ key: layoutKey, graph, waves, tasks });
  const [laidOut, setLaidOut] = useState<ReadyLayout | null>(null);
  const [showIsolated, setShowIsolated] = useState(true);
  const now = useNow(tasks);

  // Keep the input a topology-keyed effect will read current without making every fresh snapshot
  // a reason for that effect to run. Effects execute in declaration order, so a changed key sees
  // this render's graph before the layout request below starts.
  useEffect(() => {
    layoutInput.current = { key: layoutKey, graph, waves, tasks };
  }, [layoutKey, graph, waves, tasks]);

  useEffect(() => {
    let current = true;
    const requested = layoutInput.current;
    // elkjs is async. Nodes are drawn once they have somewhere to be — a canvas of overlapping
    // nodes at (0, 0) for a frame is worse than a canvas that arrives whole. After that first
    // usable layout, the mounted canvas stays visible while a changed topology gets replacements.
    void layoutGraph(requested.graph, requested.waves).then((layout) => {
      if (current) setLaidOut({ ...requested, layout });
    });
    return () => {
      current = false;
    };
  }, [layoutKey]);

  // Fresh SSE snapshots rebuild every object. Placement identity is narrower: task identity and
  // order, dependency topology, and wave membership. When that key still matches, the old
  // positions dress the newest task/status/cast data immediately. When it changes, the previous
  // graph remains the usable canvas until elk supplies a complete replacement.
  const drawn = useMemo(
    () =>
      laidOut && laidOut.key === layoutKey
        ? { graph, waves, tasks, layout: laidOut.layout }
        : laidOut
          ? refreshPresentation(laidOut, tasks)
          : null,
    [laidOut, layoutKey, graph, waves, tasks]
  );

  // Which tasks the selected agent ever held — including the ones a later attempt handed to
  // somebody else, because those are still tasks that agent worked on and hid nothing about.
  const agentTasks = useMemo(() => {
    const member = cast.find((candidate) => candidate.handle === selectedAgent);
    return member ? new Set(member.taskIds) : null;
  }, [cast, selectedAgent]);

  const nodes = useMemo(
    () =>
      drawn
        ? [
            ...toWaveNodes(drawn.layout.boxes, drawn.waves),
            // `drawn` is the preserved canvas (#75) — possibly last frame's *positions* dressed in
            // this frame's tasks. `now` is the live clock (#47): worker health has to keep ageing
            // on those preserved nodes, or a canvas that survived an SSE push would freeze its
            // heartbeats. Preservation is about placement, never about staleness.
            ...toTaskNodes(drawn.graph, drawn.layout, showIsolated, {
              cast,
              agentTasks,
              selectedTaskId,
              pulses,
              now,
            }),
          ]
        : [],
    [drawn, showIsolated, cast, agentTasks, selectedTaskId, pulses, now]
  );

  const edges = useMemo(
    () => (drawn ? toEdges(drawn.graph.edges, drawn.tasks, agentTasks, now) : []),
    [drawn, agentTasks, now]
  );

  if (tasks.length === 0) {
    return (
      <Empty>
        <p role="status" className="max-w-sm text-balance">
          No tasks in this database yet — nothing has been dispatched.
        </p>
      </Empty>
    );
  }

  if (!drawn) {
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
      <ReactFlow<TaskFlowNode | WaveFlowNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        // A one-task run must not blow that task up to fill a 1600px canvas: fitting *to* the graph
        // is the point, magnifying it is not. Zooming in past 1:1 is still yours to do.
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.05}
        nodesDraggable={false}
        nodesConnectable={false}
        onNodeClick={(_, node) => {
          if (node.type === 'task') onSelectTask(node.id);
        }}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap<TaskFlowNode | WaveFlowNode>
          // The most expendable chrome at phone size: a second rendering of a graph the thumb
          // can already pan. Hidden by class rather than unmounted, so jsdom keeps seeing it.
          className="max-lg:hidden"
          pannable
          zoomable
          // A wave is a region of the field, not a node — painting it on the minimap would put a
          // third of the map under one flat block and bury the nodes it exists to locate.
          nodeColor={(node) => (node.type === 'wave' ? 'transparent' : themeOf(node.data.task.status).accent)}
          nodeBorderRadius={3}
        />

        {/* Inside `<ReactFlow>`, because that is where its viewport context lives. */}
        <CentreOnSelection selectedTaskId={selectedTaskId} nodes={nodes} />
        <Refit signal={refitSignal} selectedTaskId={selectedTaskId} />

        {drawn.graph.edges.length === 0 && (
          <Panel position="top-center">
            {/* `max-lg:mt-11` drops it below the isolated toggle — at 360px the two chips share a row's worth of width and would collide. */}
            <p data-testid="edgeless-note" className={cn(CANVAS_CHIP_CLASS, 'text-muted-foreground px-3.5 py-1.5 text-xs max-lg:mt-11')}>
              No dependencies in this run — {drawn.tasks.length} tasks dispatched independently.
            </p>
          </Panel>
        )}

        {drawn.graph.isolated.length > 0 && (
          <Panel position="top-left">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowIsolated((shown) => !shown)}
              aria-expanded={showIsolated}
              className={cn(CANVAS_CHIP_CLASS, 'hover:bg-accent h-7 gap-1 px-3 text-xs max-lg:h-10')}
            >
              {showIsolated ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
              Isolated tasks ({drawn.graph.isolated.length})
            </Button>
          </Panel>
        )}

        {/*
          The one thing on this canvas a first-time reader cannot work out for themselves: that two
          colour systems are running at once, and which is which. It costs a line, and without it
          the stripe is decoration.
        */}
        {/*
          And it is the one chip the fold takes back (`max-lg:hidden`): with a band open, the
          canvas can stand at its 96px floor, where a bottom-centre legend sits *on* the isolated
          toggle and the zoom controls rather than under them. A legend worn as a collision
          explains nothing — the colours still explain themselves on the nodes.
        */}
        <Panel position="bottom-center" className="max-lg:hidden">
          <p className={cn(CANVAS_CHIP_CLASS, 'text-muted-foreground px-3.5 py-1 text-[11px]')}>
            fill = status · stripe = agent
          </p>
        </Panel>
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
 * "Click a row → its node highlights **and centres**" (SPEC §7.6) — the half of the link that a
 * highlight alone does not deliver. On a 76-node canvas the node you were sent to is usually off
 * screen, and an outline you have to go hunting for is not an answer to *where*.
 *
 * It centres **once per selection**, never on every push: the node data carries a fresh `now` on
 * each tick, so an effect that re-ran with the nodes would drag the viewport back every five
 * seconds and make the canvas impossible to pan away from.
 *
 * It waits for the layout, rather than giving up when it misses. Selecting a row whose task is in
 * *another* run switches runs, and that run's elkjs layout is async — so the node does not exist
 * yet at the moment the selection changes. The effect re-runs when the placements land, and the
 * guard makes the second run the one that centres.
 */
function CentreOnSelection({
  selectedTaskId,
  nodes,
}: {
  selectedTaskId: string | null;
  nodes: (TaskFlowNode | WaveFlowNode)[];
}) {
  const flow = useReactFlow();
  const isMobile = useIsMobile();
  const centred = useRef<string | null>(null);
  // Whether the canvas has any pixels to centre within. The folded shell can select a task
  // while a band holds the whole column and the canvas measures 0 — desktop never does, and
  // jsdom's shimmed geometry reports a real size, so this is inert everywhere but the fold.
  const sized = useStore((state) => state.width > 0 && state.height > 0);

  useEffect(() => {
    if (selectedTaskId === null) {
      centred.current = null;
      return;
    }
    if (centred.current === selectedTaskId) return;

    const node = nodes.find((candidate) => candidate.id === selectedTaskId);
    if (!node) return; // Not laid out yet, or not in this run. Try again when the nodes change.

    // A centre computed against a 0×0 viewport lands nowhere. Leaving `centred` unclaimed keeps
    // the selection live, so it centres the moment the canvas regains height.
    if (!sized) return;

    const centre = (): void => {
      centred.current = selectedTaskId;
      flow.setCenter(node.position.x + NODE_WIDTH / 2, node.position.y + NODE_HEIGHT / 2, {
        // The zoom the user chose is theirs. Centring moves the canvas *to* the node; it does
        // not decide how close they wanted to be standing.
        zoom: flow.getZoom(),
        duration: 300,
      });
    };

    // Desktop centres now, exactly as it always has: selecting a task moves nothing around the
    // canvas, so the dimensions `setCenter` reads are the dimensions on screen.
    if (!isMobile) {
      centre();
      return;
    }

    // On the fold, the tap that selected this node usually opened the dock band in the same
    // commit — and React Flow learns the shrunken height only when its ResizeObserver reports,
    // during the next frame's rendering steps, *after* this effect. A centre computed now would
    // aim for the middle of a canvas that is no longer there and park the node under the band.
    // Two frames put the arithmetic on the far side of that delivery; the claim rides along, so
    // the selection is still centred exactly once — a re-render in the gap (a push tick
    // rebuilding the nodes) cancels and reschedules rather than centring twice or never.
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(centre);
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [selectedTaskId, nodes, flow, sized, isMobile]);

  return null;
}

/**
 * The two moments the folded shell is allowed to re-frame the graph — and only these two,
 * because "the viewport the user framed is theirs" (CentreOnSelection, above) is doctrine:
 *
 * - **Rotation.** Turning the phone is the reader's own gesture; re-fitting on it is not a
 *   yank (SPEC §7.3), it is answering the question the gesture asked.
 * - **The dock band collapsing after a cross-run hop** (`refitSignal`). The new run's fit
 *   ran while the band held 60dvh of the column; collapsing it should land on a freshly
 *   framed graph, not a mid-layout one.
 *
 * Band expand/collapse otherwise never re-fits: the bands push the canvas rather than cover
 * it, so a shrunken canvas is still the frame the reader chose to stand in, and re-fitting on
 * every fold would make the graph twitch under each tap. Both re-frames defer one frame so
 * React Flow's own ResizeObserver has measured the resized container first, and both stand
 * down while a task is selected — a selection is centred, and a fit that zoomed away from it
 * would trade the reader's place for a tidier frame.
 */
function Refit({ signal, selectedTaskId }: { signal: number; selectedTaskId: string | null }) {
  const flow = useReactFlow();
  const isMobile = useIsMobile();
  // The last signal value already answered — a dropped one (arriving mid-selection) stays
  // answered, so deselecting the task later does not replay a stale re-fit.
  const seen = useRef(signal);

  useEffect(() => {
    if (!isMobile) {
      seen.current = signal;
      return;
    }

    // The exact options of the initial `fitView` (the ReactFlow element, above): an overview,
    // never a magnification.
    const fit = () => requestAnimationFrame(() => flow.fitView({ padding: 0.2, maxZoom: 1 }));

    if (signal !== seen.current) {
      seen.current = signal;
      if (selectedTaskId === null) fit();
    }

    const orientation = globalThis.matchMedia?.('(orientation: portrait)');
    const onFlip = () => {
      if (selectedTaskId === null) fit();
    };
    orientation?.addEventListener('change', onFlip);
    return () => orientation?.removeEventListener('change', onFlip);
  }, [isMobile, signal, selectedTaskId, flow]);

  return null;
}

/**
 * The wave regions, behind everything.
 *
 * `zIndex: -1` puts them under the nodes *and* under the edges, which is where a region of the
 * field belongs: a task that depends on a task in the previous wave draws a line across the
 * border, and the line is the fact — the border is the context.
 */
function toWaveNodes(boxes: WaveBox[], waves: Wave[]): WaveFlowNode[] {
  const current = new Map(waves.map((wave) => [wave.index, wave]));
  return boxes.map((box) => ({
    id: `wave-${box.wave.index}`,
    type: 'wave' as const,
    position: { x: box.x, y: box.y },
    width: box.width,
    height: box.height,
    // Times and the idle-gap caption can change without moving a task. Keep the geometry and
    // refresh that presentation from the newest snapshot instead of making it a layout input.
    data: {
      wave: current.get(box.wave.index) ?? box.wave,
      caption: spanOf(current.get(box.wave.index) ?? box.wave),
    },
    draggable: false,
    selectable: false,
    focusable: false,
    zIndex: -1,
  }));
}

/**
 * The values that can move a node — and only those values.
 *
 * Status, dispatch, heartbeat, gate, cast, message and selection data all repaint the existing
 * nodes. A wave's task ids are its spatial membership/bounds; its timestamps only caption the box
 * and cannot move it. Including presentation data here would turn an ordinary stream push into an
 * elk run and make object allocation observable as a viewport reset (issue #46).
 */
function layoutKeyOf(graph: Graph, waves: Wave[]): string {
  return JSON.stringify({
    connected: graph.connected.map((task) => task.id),
    isolated: graph.isolated.map((task) => task.id),
    edges: graph.edges.map(({ source, target }) => [source, target]),
    waves: waves.map((wave) => ({ index: wave.index, taskIds: wave.taskIds })),
  });
}

/**
 * Keep the previous placement topology during an elk run, but repaint every task that still exists
 * from the newest snapshot. A push can add an edge and complete a task at the same instant; layout
 * may wait, but the completion is already a fact and must not.
 */
function refreshPresentation(previous: ReadyLayout, tasks: Task[]): ReadyLayout {
  const current = new Map(tasks.map((task) => [task.id, task]));
  const refresh = (task: Task): Task => current.get(task.id) ?? task;

  return {
    ...previous,
    graph: {
      connected: previous.graph.connected.map(refresh),
      isolated: previous.graph.isolated.map(refresh),
      edges: previous.graph.edges,
    },
    tasks: previous.tasks.map(refresh),
  };
}

/** "Jul 11, 20:10 → 23:47" — when this burst of work happened, in the reader's own timezone. */
function spanOf(wave: Wave): string {
  const from = new Date(wave.startedAt);
  const to = new Date(wave.endedAt);
  if (Number.isNaN(from.getTime())) return '';

  const day: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  const start = from.toLocaleString(undefined, day);

  if (Number.isNaN(to.getTime())) return start;

  // The same day, twice, is a date you have already read. The end is then only a clock time.
  const sameDay = from.toDateString() === to.toDateString();
  const end = to.toLocaleString(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : day);

  return `${start} → ${end}`;
}

/**
 * The isolated block collapses; the DAG does not. 50 disconnected singletons would otherwise
 * flatten the graph into a ribbon nobody can read — but nothing is hidden by *default* (SPEC §7.5),
 * least of all completed work, which is the payload of a post-mortem.
 */
function toTaskNodes(
  graph: Graph,
  layout: Layout,
  showIsolated: boolean,
  view: {
    cast: CastMember[];
    /** The selected agent's tasks. Null ⇒ no agent is selected and nothing dims. */
    agentTasks: ReadonlySet<string> | null;
    selectedTaskId: string | null;
    pulses: ReadonlyMap<string, Pulse>;
    now: number;
  }
): TaskFlowNode[] {
  const at = new Map(layout.placements.map((placement) => [placement.id, placement]));
  const shown = showIsolated ? [...graph.connected, ...graph.isolated] : graph.connected;

  return shown.map((task, index) => ({
    id: task.id,
    type: 'task' as const,
    position: { x: at.get(task.id)?.x ?? 0, y: at.get(task.id)?.y ?? 0 },
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    data: {
      task,
      now: view.now,
      agent: agentOf(task, view.cast),
      selected: task.id === view.selectedTaskId,
      dimmed: view.agentTasks !== null && !view.agentTasks.has(task.id),
      pulse: view.pulses.get(task.id) ?? null,
      // The draw order, so the graph resolves top-down rather than all at once (`motion.ts`).
      index,
    },
    draggable: false,
  }));
}

/**
 * Dependency edges — **a status affordance, never message flow** (SPEC §7.6). An edge into a
 * dispatched task is dashed and animated, which is how the canvas shows where work is actually in
 * flight. It is not a message travelling: messages go between *handles*, and animating one along a
 * dep edge would draw a flow that does not exist.
 *
 * An edge dims with the nodes it joins. It takes **both** ends to keep an edge lit — an edge that
 * stayed bright between two faded nodes would draw the eye to a relationship you did not ask to
 * see, which is the one thing the dimming exists to stop.
 */
function toEdges(edges: Edge[], tasks: Task[], agentTasks: ReadonlySet<string> | null, now: number): FlowEdge[] {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));

  return edges.map((edge) => {
    const target = tasksById.get(edge.target);
    const health = target ? taskWorkerHealth(target, now) : { state: 'inactive' as const };
    const inFlight = hasCurrentActivityEvidence(health);
    const dimmed = agentTasks !== null && !(agentTasks.has(edge.source) && agentTasks.has(edge.target));

    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      animated: inFlight && !dimmed,
      style: {
        strokeWidth: inFlight ? 2 : 1.5,
        strokeDasharray: inFlight ? '6 4' : undefined,
        // The one edge with something to say says it in the colour of the thing it is saying: work
        // is in flight into this task, and `dispatched` is what that looks like everywhere else.
        ...(inFlight && { stroke: themeOf('dispatched').accent }),
        ...(dimmed && { opacity: 0.15 }),
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
    };
  });
}

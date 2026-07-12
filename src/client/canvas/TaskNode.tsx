import { Handle, type NodeProps, Position, type Node } from '@xyflow/react';
import { OctagonAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { CSSProperties } from 'react';
import { Spotlight, useSpotlight } from '@/components/fx/spotlight';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { Task } from '../../shared/types.ts';
import type { Pulse } from '../feed/theme.ts';
import { enter, NODE_IN, nodeDelay, SPRING } from '../motion.ts';
import { relativeTime } from '../relative-time.ts';
import {
  GATE_THEME,
  glowOf,
  isAlive,
  NODE_HEIGHT,
  NODE_WIDTH,
  SELECTED_RING,
  STALE_HEARTBEAT_MS,
  themeOf,
} from './theme.ts';

/**
 * A task, as it appears on the canvas.
 *
 * Everything it has to say, it says without being hovered: scanning a finished run for the
 * failed node must not require interaction (SPEC §7.5).
 *
 * **The status is a light source, not a box** (SPEC §7.5). The node used to be *outlined* in its
 * status — a green rectangle drawn all the way around a green fill — and that is three ways of
 * saying one thing, the loudest of which is a hard edge closing the card off on the side furthest
 * from anything you read. So the outline is gone. What is left is a **spine**: a soft bar of the
 * status colour down the left, glowing, with the colour bleeding rightwards out of it and running
 * out before it reaches the other edge. The card is held together by its fill and its shadow, the
 * way a lit object is, and the eye still finds the failed node in a 76-node run from across the
 * canvas — because that was never the *border's* job, it was the fill's.
 *
 * Two of the things it says come from the feed rather than from the task row, and they are
 * both #18's half of the bidirectional link: the node the feed sent you to is **outlined**,
 * and a node something has just *happened* to **pulses** in the colour of the message that
 * happened (`feed/theme.ts`). The node knows neither which message nor why — it is handed a
 * colour, which is what keeps the canvas ignorant of the feed. (And the *selection* outline is
 * now the only outline a node can ever wear, which is exactly the point of it.)
 *
 * **The one node that moves** is the one with an agent inside it (SPEC §7.9). A `dispatched` task
 * wears a ring of its own amber, turning, for exactly as long as the work is in flight — and it is
 * the only spinning thing anywhere in this tool, which is what lets it mean *this is happening
 * right now* rather than *this is a card on a website*. A `failed` node glows red and holds still:
 * it is not happening, it happened, and it is the other thing you are scanning for.
 */

export type TaskNodeData = {
  task: Task;
  now: number;
  /** The task the feed row pointed at, or the one you clicked. Outlined, and centred by the canvas. */
  selected: boolean;
  /** A message about this task just arrived. ~1 s, in its type's colour. Never a heartbeat. */
  pulse: Pulse | null;
  /** Where it sits in the draw order — the entrance staggers by it, capped (`motion.ts`). */
  index: number;
};
export type TaskFlowNode = Node<TaskNodeData, 'task'>;

export function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, now, selected, pulse, index } = data;
  const theme = themeOf(task.status);
  const spotlight = useSpotlight();

  const alive = isAlive(task.status);

  return (
    <motion.div
      data-testid="task-node"
      data-task={task.id}
      data-selected={selected}
      // The *type*, not the colour: a test asserts that a `worker_done` flashed this node and
      // that a heartbeat never did, and neither of those is a question about a colour.
      data-pulse={pulse?.type}
      data-alive={alive}
      variants={NODE_IN}
      initial={enter('hidden')}
      animate="shown"
      transition={{ ...SPRING, delay: nodeDelay(index) }}
      // A node lifts a hair under the pointer. It is the smallest possible way of saying "this is
      // a thing, and it is clickable" — and on a canvas of 76 of them, the smallest is the budget.
      whileHover={{ y: -2 }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-1 rounded-xl py-2 pr-2.5 pl-4 text-[11px]',
        // The fill and the ink. `theme.surface` also carries the status *border colour* — which
        // nothing on this node draws any more, because Tailwind's reset leaves every border at
        // zero width until something asks for one, and nothing here does. It stays in the string
        // because the string is one token shared with the chips in the feed and the inspector
        // (`canvas/theme.ts`), and those wear it as an actual border.
        theme.surface,
        // Selection is an *outline*, and now the only one a node can wear: the status is a spine
        // and a fill, so a rectangle around a card can mean exactly one thing — *this is the one
        // you are looking at*.
        selected && SELECTED_RING
      )}
      style={{
        // The one thing here that is a *number* and not a look: elkjs placed every node in the
        // graph against exactly these (`layout.ts`), so they cannot become a class.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        boxShadow: shadowOf(task.status, pulse),
        ...(pulse && {
          // The keyframes are in `index.css` — the one rule a style attribute cannot express.
          animation: 'orca-pulse 1s ease-out',
          ['--orca-pulse' as string]: pulse.color,
        }),
      }}
      {...spotlight}
    >
      {/*
        The spine — the status, as the light this card is lit by. A bar rather than a border, and
        inset rather than flush, so it reads as a *mark on* the card and not the edge of it.
      */}
      <span
        aria-hidden
        className={cn('absolute top-2 bottom-2 left-1.5 w-[3px] rounded-full', theme.dot)}
        style={{ boxShadow: `0 0 10px 0 color-mix(in oklch, ${theme.accent} 55%, transparent)` }}
      />

      {/* The colour running out of the spine, and running out *before the far edge* — which is the
          whole difference between a card that is lit from one side and a card in a coloured box. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-xl"
        style={{
          background: `linear-gradient(to right, color-mix(in oklch, ${theme.accent} 20%, transparent), transparent 62%)`,
        }}
      />

      {/* The ring: an agent is inside this node, right now. Nothing else on the page spins. */}
      {alive && (
        <span
          aria-hidden
          className="orca-alive"
          style={{ ['--orca-alive-colour' as string]: theme.accent } as CSSProperties}
        />
      )}

      {/* Under everything with something to say, over the node's own fill. Lights up in the
          node's *status*, so a failed node glows red under the pointer and a completed one green. */}
      <Spotlight colour={theme.accent} />

      {/* Invisible, and still exactly where React Flow measures an edge to: the arrowheads already
          say where a dependency lands, and a grey stud on the rim of every card said it twice. */}
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 !opacity-0" />

      <div className="relative flex items-center gap-1.5">
        {/*
          The raw string, whatever it is: an unknown status names a real state (SPEC §5). Set in
          small caps with a little tracking — it is a *label*, not a sentence, and the dot that used
          to sit beside it was a third way of saying what the spine and the fill already say.
        */}
        <b className="text-[9px] font-bold tracking-[0.09em] uppercase opacity-80">{task.status}</b>
        <GateMarker task={task} />
        <RetryMarker attemptCount={task.attemptCount} />
        <Assignee task={task} />
      </div>

      <div className="relative line-clamp-3 text-[11.5px] leading-tight font-medium">{task.title}</div>

      <LastSeen task={task} now={now} />

      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !opacity-0" />
    </motion.div>
  );
}

/**
 * What lifts the card off the canvas, and what it lights up with.
 *
 * Three layers that have to be composed rather than chosen between, because they are all
 * box-shadows and a box-shadow does not stack with another one written after it:
 *
 * 1. **The sheen and the lift** — every node has them. A 1px inner highlight along the top edge is
 *    what makes a fill read as a *surface catching light* instead of a coloured rectangle, and it
 *    is doing the job the deleted border was doing badly.
 * 2. **The glow** — only `dispatched` and `failed` (`glowOf`). The two a person is hunting for.
 * 3. **The pulse** — a message just landed here. It is transient and it *wins*: a node that kept
 *    its halo while flashing would flash a duller colour than the feed handed it.
 */
function shadowOf(status: string, pulse: Pulse | null): string {
  const base = 'inset 0 1px 0 0 var(--sheen), var(--lift-2)';
  if (pulse) return `0 0 0 3px ${pulse.color}, ${base}`;

  const glow = glowOf(status);
  return glow ? `${glow}, ${base}` : base;
}

/**
 * The octagon — this task is not working, it is *waiting on you* (SPEC §7.5).
 *
 * Only while the gate is open: an answered question is history, and history belongs in the
 * inspector, not as a warning on a node that is getting on with its work. The gate the server
 * hands the node is already the right one — the open one, when the task has several.
 *
 * The status colour underneath it stays whatever the row says. A `dispatched` task with an open
 * gate is still dispatched; the marker adds the reason it is not moving, and repainting the node
 * would be inventing a status Orca never wrote.
 */
function GateMarker({ task }: { task: Task }) {
  if (task.gate?.status !== 'open') return null;

  return (
    <Badge
      data-testid="gate-marker"
      variant="outline"
      title={task.gate.question}
      // A badge, like the assignee chip beside it (SPEC §7.5) — not bare text. It is the one
      // thing on this node that means *stopped*, and on a canvas you are scanning rather than
      // reading, a shape catches the eye before a colour does. An octagon and not the ⛔ emoji,
      // which is a tofu box on any machine without an emoji font — and this is the glyph that
      // must never fail to draw.
      className={cn('gap-0.5 px-1.5 py-0 text-[10px] font-bold', GATE_THEME.surface)}
    >
      <OctagonAlert className="size-3" /> gate
    </Badge>
  );
}

/**
 * The **only** visible sign, anywhere, that a task was retried — nothing else in the schema
 * records it, and a silent re-dispatch would otherwise look like a first attempt. No task
 * has retried in real data yet, so this has to be right the first time one does.
 */
function RetryMarker({ attemptCount }: { attemptCount: number }) {
  if (attemptCount <= 1) return null;

  return (
    <span
      data-testid="retry-marker"
      title={`${attemptCount} dispatch attempts`}
      className="text-[10px] font-bold text-amber-700 dark:text-amber-400"
    >
      ↻{attemptCount}
    </span>
  );
}

/**
 * Who has it, and how close they are to the circuit breaker (it trips at 3).
 *
 * A **quiet** chip. It used to be a solid slab of the foreground colour — the loudest object on
 * the card, for a value that is a uuid you cannot read and would not act on. It is now a tint of
 * the card's own ink: still monospace, still exact, and no longer the first thing your eye lands
 * on when what you came to the node for was its status.
 */
function Assignee({ task }: { task: Task }) {
  if (!task.dispatch?.assigneeHandle) return null;
  const { assigneeHandle, failureCount } = task.dispatch;

  return (
    <span className="ml-auto flex items-center gap-1">
      {failureCount > 0 && (
        <span data-testid="failure-count" className="text-[10px] font-bold text-red-700 dark:text-red-400">
          ✗{failureCount}
        </span>
      )}
      <span
        data-testid="assignee"
        title={assigneeHandle}
        className="rounded-md bg-black/10 px-1.5 py-px font-mono text-[10px] tracking-tight opacity-70 dark:bg-white/10"
      >
        {shortHandle(assigneeHandle)}
      </span>
    </span>
  );
}

/**
 * "last seen 12s ago" — a working agent told from a hung one (#12, story 7).
 *
 * Shown only while **the dispatch** is `dispatched` (SPEC §7.5) — not while the *task* is.
 * The two come apart on real rows: a task can still read `dispatched` while its latest
 * attempt has already `failed` or tripped the breaker, and an amber "last seen 3h ago" there
 * would report a hung agent where the schema plainly says a burned attempt. On a completed
 * dispatch the last heartbeat is just the moment the work stopped, and a badge would cry
 * wolf about a run that finished perfectly well.
 */
function LastSeen({ task, now }: { task: Task; now: number }) {
  const dispatch = task.dispatch;
  if (dispatch?.status !== 'dispatched' || !dispatch.lastHeartbeatAt) return null;

  const silentFor = now - Date.parse(dispatch.lastHeartbeatAt);
  if (Number.isNaN(silentFor)) return null;

  const stale = silentFor > STALE_HEARTBEAT_MS;

  return (
    <span
      data-testid="last-seen"
      data-stale={stale}
      className={cn(
        'relative mt-auto text-[9px] opacity-60',
        stale && 'font-bold text-amber-700 opacity-100 dark:text-amber-400'
      )}
    >
      last seen {relativeTime(silentFor)} ago
    </span>
  );
}

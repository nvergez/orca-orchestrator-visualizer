import { Handle, type NodeProps, Position, type Node } from '@xyflow/react';
import { OctagonAlert } from 'lucide-react';
import { motion } from 'motion/react';
import type { CSSProperties } from 'react';
import { Spotlight, useSpotlight } from '@/components/fx/spotlight';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { Task } from '../../shared/types.ts';
import type { Pulse } from '../conversation/theme.ts';
import { enter, NODE_IN, nodeDelay, SPRING } from '../motion.ts';
import { relativeTime } from '../relative-time.ts';
import {
  type AgentLook,
  GATE_THEME,
  glowOf,
  isAlive,
  MONOGRAM_CLASS,
  NODE_HEIGHT,
  NODE_WIDTH,
  SELECTED_RING,
  themeOf,
} from './theme.ts';
import { STALE_HEARTBEAT_MS } from '../../shared/run-health.ts';

/**
 * A task, as it appears on the canvas.
 *
 * Everything it has to say, it says without being hovered: scanning a finished run for the
 * failed node must not require interaction (SPEC §7.5).
 *
 * **The status keeps the hue; the agent takes the edge** (SPEC §7.5). Two colour systems want this
 * card — what state the work is in, and who did it — and they cannot both win the same pixel. So
 * they are given different channels rather than a washed-out hue apiece:
 *
 * - **The status is the *fill*, and the light.** Those six hexes were signed off on screen and
 *   retuning them to make room for anything is re-approval, not refactoring. The fill is also what
 *   was always doing the work: a failed node is found from across a 76-node run by its *red*, not
 *   by an outline. It keeps the ink, the colour bleeding rightwards across the card, and — for the
 *   two statuses a person is actually hunting — the glow around it.
 * - **The agent is the *stripe and the monogram*.** A 4px bar down the left and an `A1` badge, in
 *   a colour nothing else on the card was using. A node with no agent wears a faint stripe and no
 *   badge, which is the truth: nobody was ever dispatched to it.
 *
 * The uuid is gone from the face of the card. It was the loudest thing on a node for a value you
 * cannot read, cannot hold in your head and would not act on; `A2` is the same fact in two
 * characters, it is the *same* `A2` in the rail and in the conversation, and the handle itself is
 * one hover away.
 *
 * Two of the things it says come from elsewhere, and they are the bidirectional link: the node the
 * conversation sent you to is **outlined**, and a node something has just *happened* to **pulses**
 * in the colour of the message that happened. **Dimming** is the third: when an agent is selected
 * in the rail, every node that is not theirs fades back, which is the tool's central gesture — the
 * canvas answering "show me what A2 did".
 *
 * **The one node that moves** is the one with an agent inside it (SPEC §7.9). A `dispatched` task
 * wears a ring of its own amber, turning, for exactly as long as the work is in flight — and it is
 * the only spinning thing anywhere in this tool.
 */

export type TaskNodeData = {
  task: Task;
  now: number;
  /** Who has it — the stripe and the monogram. Null ⇒ nobody was dispatched to it (`theme.ts`). */
  agent: AgentLook | null;
  /** The task the conversation pointed at, or the one you clicked. Outlined, and centred. */
  selected: boolean;
  /** An agent is selected and this is not their task. Faded, never hidden (SPEC §7.5). */
  dimmed: boolean;
  /** A message about this task just arrived. ~1 s, in its type's colour. Never a heartbeat. */
  pulse: Pulse | null;
  /** Where it sits in the draw order — the entrance staggers by it, capped (`motion.ts`). */
  index: number;
};
export type TaskFlowNode = Node<TaskNodeData, 'task'>;

export function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, now, agent, selected, dimmed, pulse, index } = data;
  const theme = themeOf(task.status);
  const spotlight = useSpotlight();

  const alive = isAlive(task.status);

  return (
    <motion.div
      data-testid="task-node"
      data-task={task.id}
      data-selected={selected}
      data-dimmed={dimmed}
      data-agent={agent?.monogram}
      // The *type*, not the colour: a test asserts that a `worker_done` flashed this node and
      // that a heartbeat never did, and neither of those is a question about a colour.
      data-pulse={pulse?.type}
      data-alive={alive}
      variants={NODE_IN}
      initial={enter('hidden')}
      // A *variant*, and not an `opacity-20` class: `shown` writes `opacity: 1` into the inline
      // style, and an inline style beats a class — so a dim expressed as a class would be silently
      // overridden and the canvas would never fade at all (`motion.ts`).
      animate={dimmed ? 'dimmed' : 'shown'}
      transition={{ ...SPRING, delay: nodeDelay(index) }}
      // A node lifts a hair under the pointer. It is the smallest possible way of saying "this is
      // a thing, and it is clickable" — and on a canvas of 76 of them, the smallest is the budget.
      whileHover={{ y: -2 }}
      className={cn(
        'group relative flex cursor-pointer flex-col gap-1 rounded-xl py-2 pr-2.5 pl-4 text-[11px]',
        // The fill and the ink. `theme.surface` also carries the status *border colour* — which
        // nothing on this node draws any more, because Tailwind's reset leaves every border at
        // zero width until something asks for one, and nothing here does. It stays in the string
        // because the string is one token shared with the chips in the conversation and the
        // inspector (`canvas/theme.ts`), and those wear it as an actual border.
        theme.surface,
        // Selection is an *outline*, and the only one a node can wear: the status is a fill and
        // the agent is a stripe, so a rectangle around a card can mean exactly one thing — *this
        // is the one you are looking at*.
        selected && SELECTED_RING,
        // A dimmed node is still a node, and still holds its place — but it is not one you are being
        // invited to click, so it stops answering the pointer.
        dimmed && 'pointer-events-none'
      )}
      style={{
        // The one thing here that is a *number* and not a look: elkjs placed every node in the
        // graph against exactly these (`layout.ts`), so they cannot become a class.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        boxShadow: shadowOf(task.status, pulse, dimmed),
        ...(pulse && {
          // The keyframes are in `index.css` — the one rule a style attribute cannot express.
          animation: 'orca-pulse 1s ease-out',
          ['--orca-pulse' as string]: pulse.color,
        }),
      }}
      {...spotlight}
    >
      {/*
        **The stripe — the agent.** A bar rather than a border, and inset rather than flush, so it
        reads as a *mark on* the card and not the edge of it. A task nobody was dispatched to gets
        the same bar in the card's own ink at a whisper, because an absent agent is a fact and a
        missing stripe is a rendering hole.
      */}
      <span
        aria-hidden
        data-testid="agent-stripe"
        className="absolute top-2 bottom-2 left-1.5 w-[4px] rounded-full"
        style={{
          background: agent?.colour ?? 'color-mix(in oklch, currentColor 22%, transparent)',
          ...(agent && { boxShadow: `0 0 10px 0 color-mix(in oklch, ${agent.colour} 55%, transparent)` }),
        }}
      />

      {/* The *status*, bleeding rightwards across the card and running out before the far edge —
          which is the whole difference between a card that is lit from one side and a card in a
          coloured box. It is the fill's own colour, so the status still owns the surface even
          though the left edge now belongs to somebody else. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-xl"
        style={{
          background: `linear-gradient(to right, color-mix(in oklch, ${theme.accent} 20%, transparent), transparent 62%)`,
        }}
      />

      {/* The ring: an agent is inside this node, right now. Nothing else on the page spins. */}
      {alive && !dimmed && (
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
        <Monogram agent={agent} handle={task.dispatch?.assigneeHandle ?? null} />

        {/*
          The raw string, whatever it is: an unknown status names a real state (SPEC §5). Set in
          small caps with a little tracking — it is a *label*, not a sentence.
        */}
        <b className="text-[9px] font-bold tracking-[0.09em] uppercase opacity-80">{task.status}</b>
        <GateMarker task={task} />
        <RetryMarker attemptCount={task.attemptCount} />
        <FailureCount task={task} />
      </div>

      <div className="relative line-clamp-2 text-[11.5px] leading-tight font-medium">{task.title}</div>

      <LastSeen task={task} now={now} />

      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 !opacity-0" />
    </motion.div>
  );
}

/**
 * **`A2`** — who worked this task, in two characters you can actually follow.
 *
 * It replaces the eight hex of the assignee handle that used to sit here. That chip was the
 * loudest object on the card, for a uuid you cannot read, cannot remember and would not act on —
 * and, worse, it was the *only* name the agent had, so "the failed node and the open gate are the
 * same agent" was a fact you had to work out by comparing two strings of hex. The monogram is one
 * glance, it is the same `A2` in the rail and in the conversation, and the handle itself has not
 * gone anywhere: it is in the tooltip, and in full.
 */
function Monogram({ agent, handle }: { agent: AgentLook | null; handle: string | null }) {
  if (agent === null) return null;

  return (
    <span
      data-testid="assignee"
      title={handle ?? undefined}
      className={cn(MONOGRAM_CLASS, 'size-[17px] text-[8.5px]')}
      style={{ background: agent.colour }}
    >
      {agent.monogram}
    </span>
  );
}

/**
 * What lifts the card off the canvas, and what it lights up with.
 *
 * Layers that have to be composed rather than chosen between, because they are all box-shadows and
 * a box-shadow does not stack with another one written after it:
 *
 * 1. **The sheen and the lift** — every node has them. A 1px inner highlight along the top edge is
 *    what makes a fill read as a *surface catching light* instead of a coloured rectangle, and it
 *    is doing the job the deleted border was doing badly.
 * 2. **The glow** — only `dispatched` and `failed` (`glowOf`). The two a person is hunting for.
 *    A **dimmed** node does not glow: it is not the one you asked to see, and a halo is exactly the
 *    thing that would drag the eye back to it through the fade.
 * 3. **The pulse** — a message just landed here. It is transient and it *wins*: a node that kept
 *    its halo while flashing would flash a duller colour than the conversation handed it.
 */
function shadowOf(status: string, pulse: Pulse | null, dimmed: boolean): string {
  const base = 'inset 0 1px 0 0 var(--sheen), var(--lift-2)';
  if (pulse) return `0 0 0 3px ${pulse.color}, ${base}`;

  const glow = dimmed ? undefined : glowOf(status);
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
 * How close this agent is to the circuit breaker — it trips at 3 (SPEC §4.1).
 *
 * It used to ride beside the assignee's hex chip. The chip is now a monogram at the head of the
 * row, and the failure count stayed *here*, at the end of it, because they answer different
 * questions: the monogram is who, and this is how badly it is going.
 */
function FailureCount({ task }: { task: Task }) {
  const failureCount = task.dispatch?.failureCount ?? 0;
  if (failureCount <= 0) return null;

  return (
    <span
      data-testid="failure-count"
      title={`${failureCount} failed attempt${failureCount === 1 ? '' : 's'} — the circuit breaker trips at 3`}
      className="ml-auto text-[10px] font-bold text-red-700 dark:text-red-400"
    >
      ✗{failureCount}
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

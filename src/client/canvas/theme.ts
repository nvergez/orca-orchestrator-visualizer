import type { CastMember, Task, TaskStatus } from '../../shared/types.ts';
export { STALE_HEARTBEAT_MS } from '../worker-health.ts';

/**
 * How a task *looks* — the visual decisions the dev signed off on screen against the live
 * prototype (`prototype/src/`, SPEC §7.5), transcribed. Retuning any of this is re-approval,
 * not refactoring.
 *
 * The colours themselves are **not here**: they are CSS variables (`index.css`), because the
 * page has a light theme and a dark one and a hex compiled into a bundle cannot flip between
 * them. What is here is the seam that hands them out, in the two forms the page actually needs:
 *
 * - **`surface`** — Tailwind classes, for anything Tailwind can paint. A node and a chip of the
 *   same status wear the *same string*, which is how "one palette for the page" stays true by
 *   construction rather than by discipline (`conversation/theme.ts`).
 * - **`accent`** — a `var(--…)` value, for the two places that need a colour and not a class:
 *   React Flow's minimap fill, and the box-shadow of a pulse.
 */

/** 240 × 84, title clamped to three lines. Nothing is hidden behind a hover (SPEC §7.5). */
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 84;

/**
 * The one colour on the page that is not a status: *this is the one you are looking at*. The
 * node you selected — or that a turn in the conversation sent you to — the run the rail has open, the
 * scope the conversation is in. The same blue, so that being selected looks like one thing wherever it
 * happens.
 */
export const SELECTED_RING = 'outline-2 outline-offset-2 outline-selection';

export type StatusTheme = {
  /** The soft fill, its ink and its border, as one class string — worn by a node and a chip alike. */
  surface: string;
  /** The colour itself, for the minimap and the pulse. A value, because neither of them takes a class. */
  accent: string;
  /** The accent as a fill: the dot on a node, and the dot on a dependency chip. */
  dot: string;
  /**
   * The accent as a **border and nothing else** — for the one surface that wants the outline
   * without the fill: a conversation bubble (`conversation/TurnRow.tsx`).
   *
   * A thread of thirty coloured slabs is a thread nobody reads twice, so a bubble keeps the panel's
   * own fill and takes only the rim. Spelled out rather than sliced out of `surface` at runtime,
   * because Tailwind reads the source and a class it cannot see written down is a class it does not
   * ship.
   */
  border: string;
};

/**
 * The colour of a **blocked** orchestration — the ⛔ badge on a node, and the strip above the
 * canvas (SPEC §7.4, §7.5). One entry, read by both, so the thing that interrupts you looks the
 * same wherever it catches your eye. (The rail's flag is the bare ⛔ glyph, which carries its
 * own colour and takes none from here.)
 *
 * Orange, and deliberately *not* the amber a `dispatched` node already wears: amber is "work in
 * flight", and a gate is the opposite of that — the work has stopped, and it is waiting on a
 * human. Two meanings in one colour would cost the strip the only thing it is for, which is
 * being noticed.
 */
export const GATE_THEME: StatusTheme = {
  surface: 'bg-gate-soft text-gate-ink border-gate',
  accent: 'var(--color-gate)',
  dot: 'bg-gate',
  border: 'border-gate',
};

/**
 * The six statuses (SPEC §7.5, and the colour table locked in #12). The light value of every
 * variable below is the prototype's own hex; the dark ones flip the fill and the ink and keep
 * the accent, because a green that changed with the theme would be two greens.
 *
 * The class strings are spelled out rather than assembled from the status name: Tailwind reads
 * the source, and a class it cannot see written down is a class it does not ship.
 */
export const STATUS_THEME: Record<TaskStatus, StatusTheme> = {
  pending: {
    surface: 'bg-status-pending-soft text-status-pending-ink border-status-pending',
    accent: 'var(--color-status-pending)',
    dot: 'bg-status-pending',
    border: 'border-status-pending',
  },
  ready: {
    surface: 'bg-status-ready-soft text-status-ready-ink border-status-ready',
    accent: 'var(--color-status-ready)',
    dot: 'bg-status-ready',
    border: 'border-status-ready',
  },
  dispatched: {
    surface: 'bg-status-dispatched-soft text-status-dispatched-ink border-status-dispatched',
    accent: 'var(--color-status-dispatched)',
    dot: 'bg-status-dispatched',
    border: 'border-status-dispatched',
  },
  completed: {
    surface: 'bg-status-completed-soft text-status-completed-ink border-status-completed',
    accent: 'var(--color-status-completed)',
    dot: 'bg-status-completed',
    border: 'border-status-completed',
  },
  failed: {
    surface: 'bg-status-failed-soft text-status-failed-ink border-status-failed',
    accent: 'var(--color-status-failed)',
    dot: 'bg-status-failed',
    border: 'border-status-failed',
  },
  blocked: {
    surface: 'bg-status-blocked-soft text-status-blocked-ink border-status-blocked',
    accent: 'var(--color-status-blocked)',
    dot: 'bg-status-blocked',
    border: 'border-status-blocked',
  },
};

/**
 * A status from an Orca newer than this build. Neutral grey, and the raw string is the chip
 * label — the task is *shown*, in a colour that claims nothing about it (SPEC §5).
 */
export const UNKNOWN_STATUS_THEME: StatusTheme = {
  surface: 'bg-status-unknown-soft text-status-unknown-ink border-status-unknown',
  accent: 'var(--color-status-unknown)',
  dot: 'bg-status-unknown',
  border: 'border-status-unknown',
};

export function isKnownStatus(status: string): status is TaskStatus {
  return status in STATUS_THEME;
}

export function themeOf(status: string): StatusTheme {
  return isKnownStatus(status) ? STATUS_THEME[status] : UNKNOWN_STATUS_THEME;
}

/**
 * **The agent, on a node that a status already owns.**
 *
 * Two colour systems, one pixel — so they are given different channels rather than a compromise
 * hue apiece. The **status keeps the fill** (SPEC §7.5: those six were signed off on screen, and
 * retuning them to make room is re-approval, not refactoring). The **agent takes the stripe down
 * the left, and the monogram badge** — a channel nothing else was using, and the one a person can
 * follow across a canvas without ever reading a uuid.
 *
 * Four colours, cycled (`index.css`): a run's fifth agent wears the first one's teal again and is
 * still unmistakably **A5**, because the identity is the monogram and the colour is only what
 * makes it findable at a glance.
 */
const AGENT_COLOURS = ['var(--agent-1)', 'var(--agent-2)', 'var(--agent-3)', 'var(--agent-4)'] as const;

/** What a node, a rail row and a conversation bubble all need to draw one agent the same way. */
export type AgentLook = {
  /** The stripe, and the badge's fill. A `var(--…)`, because it is a value and not a class. */
  colour: string;
  monogram: string;
};

/**
 * The agent that has a task **now** — its latest attempt's assignee (`Task.dispatch`).
 *
 * Null is a real answer and it means one of three true things: the task was never dispatched, its
 * dispatch names no assignee, or the orchestrator worked it itself (`cast.ts` keeps a coordinator
 * out of its own cast). All three come out as the same neutral, unmonogrammed node — which is
 * exactly right, because in none of them was an *agent* spawned for the work.
 */
export function agentOf(task: Task, cast: CastMember[]): AgentLook | null {
  const handle = task.dispatch?.assigneeHandle;
  if (!handle) return null;

  const index = cast.findIndex((member) => member.handle === handle);
  if (index === -1) return null;

  return { colour: AGENT_COLOURS[index % AGENT_COLOURS.length]!, monogram: cast[index]!.monogram };
}

/** The same look, from the handle alone — what the rail and the conversation have to hand. */
export function agentLook(handle: string | null, cast: CastMember[]): AgentLook | null {
  if (handle === null) return null;

  const index = cast.findIndex((member) => member.handle === handle);
  if (index === -1) return null;

  return { colour: AGENT_COLOURS[index % AGENT_COLOURS.length]!, monogram: cast[index]!.monogram };
}

/** The badge every monogram wears — the agent's colour, solid, with the ink that reads on it. */
export const MONOGRAM_CLASS =
  'flex shrink-0 items-center justify-center rounded-md font-mono font-bold text-agent-ink tracking-tight';

/**
 * The status with an agent **inside it right now** — the one node on the canvas that is not a
 * record of something, but a thing that is happening (SPEC §7.9).
 *
 * It is the only node that moves: a ring of its own amber turns slowly around it, for exactly as
 * long as the work is in flight. That is the whole rule the canvas's motion budget is spent on,
 * and it is why nothing else on the page is allowed to spin — a second spinning thing would make
 * this one mean "decorated" instead of "working".
 *
 * A single status and not a set, because there is only one thing that is *in progress*: `ready` is
 * waiting for a slot, `blocked` is waiting for an answer, and neither of them has an agent burning
 * tokens on it.
 */
export const ALIVE_STATUS = 'dispatched';

export function isAlive(status: string): boolean {
  return status === ALIVE_STATUS;
}

/**
 * The two statuses loud enough to light the canvas *around* them — work in flight, and work that
 * broke. They are the two a person scanning a 76-node run is actually looking for, and a glow is
 * what finds a node before its colour does at a zoom where the text has stopped being legible.
 *
 * Nothing else glows. A canvas where every node glows is a canvas with a haze on it.
 */
export function glowOf(status: string): string | undefined {
  if (!isAlive(status) && status !== 'failed') return undefined;

  const accent = themeOf(status).accent;
  // `--glow-strength` is the theme's: a dark field can take a bright halo, and a white one is
  // washed out by the same halo at the same strength.
  return `0 0 24px -6px color-mix(in oklch, ${accent} calc(var(--glow-strength) * 100%), transparent)`;
}

import type { TaskStatus } from '../../shared/types.ts';

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
 *   construction rather than by discipline (`feed/theme.ts`).
 * - **`accent`** — a `var(--…)` value, for the two places that need a colour and not a class:
 *   React Flow's minimap fill, and the box-shadow of a pulse.
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

/**
 * The one colour on the page that is not a status: *this is the one you are looking at*. The
 * node you selected — or that a feed row sent you to (#18) — the run the rail has open, the
 * scope the feed is in. The same blue, so that being selected looks like one thing wherever it
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
  },
  ready: {
    surface: 'bg-status-ready-soft text-status-ready-ink border-status-ready',
    accent: 'var(--color-status-ready)',
    dot: 'bg-status-ready',
  },
  dispatched: {
    surface: 'bg-status-dispatched-soft text-status-dispatched-ink border-status-dispatched',
    accent: 'var(--color-status-dispatched)',
    dot: 'bg-status-dispatched',
  },
  completed: {
    surface: 'bg-status-completed-soft text-status-completed-ink border-status-completed',
    accent: 'var(--color-status-completed)',
    dot: 'bg-status-completed',
  },
  failed: {
    surface: 'bg-status-failed-soft text-status-failed-ink border-status-failed',
    accent: 'var(--color-status-failed)',
    dot: 'bg-status-failed',
  },
  blocked: {
    surface: 'bg-status-blocked-soft text-status-blocked-ink border-status-blocked',
    accent: 'var(--color-status-blocked)',
    dot: 'bg-status-blocked',
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
};

export function isKnownStatus(status: string): status is TaskStatus {
  return status in STATUS_THEME;
}

export function themeOf(status: string): StatusTheme {
  return isKnownStatus(status) ? STATUS_THEME[status] : UNKNOWN_STATUS_THEME;
}

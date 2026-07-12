import type { TaskStatus } from '../../shared/types.ts';

/**
 * How a task *looks* — the visual decisions the dev signed off on screen against the live
 * prototype (`prototype/src/`, SPEC §7.5), transcribed. Retuning any of this is re-approval,
 * not refactoring.
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
 * The one colour on the canvas that is not a status: the outline on the node you selected —
 * or that a feed row sent you to (#18). It is the blue the rail already marks the selected run
 * with, because it means the same thing: *this is the one you are looking at*.
 */
export const SELECTED_OUTLINE = '#3b82f6';

export type StatusColor = { bg: string; border: string; text: string };

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
export const GATE_COLOR: StatusColor = { bg: '#ffedd5', border: '#f97316', text: '#9a3412' };

/** Verbatim from the approved prototype (SPEC §7.5, and the colour table locked in #12). */
export const STATUS_COLORS: Record<TaskStatus, StatusColor> = {
  pending: { bg: '#f4f4f5', border: '#a1a1aa', text: '#3f3f46' },
  ready: { bg: '#dbeafe', border: '#3b82f6', text: '#1e3a8a' },
  dispatched: { bg: '#fef3c7', border: '#f59e0b', text: '#78350f' },
  completed: { bg: '#dcfce7', border: '#22c55e', text: '#14532d' },
  failed: { bg: '#fee2e2', border: '#ef4444', text: '#7f1d1d' },
  blocked: { bg: '#f3e8ff', border: '#a855f7', text: '#581c87' },
};

/**
 * A status from an Orca newer than this build. Neutral grey, and the raw string is the chip
 * label — the task is *shown*, in a colour that claims nothing about it (SPEC §5).
 */
export const UNKNOWN_STATUS_COLOR: StatusColor = { bg: '#e4e4e7', border: '#71717a', text: '#27272a' };

export function isKnownStatus(status: string): status is TaskStatus {
  return status in STATUS_COLORS;
}

export function colorOf(status: string): StatusColor {
  return isKnownStatus(status) ? STATUS_COLORS[status] : UNKNOWN_STATUS_COLOR;
}

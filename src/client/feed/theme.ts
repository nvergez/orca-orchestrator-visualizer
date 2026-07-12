import { STATUS_COLORS, type StatusColor, UNKNOWN_STATUS_COLOR } from '../canvas/theme.ts';

/**
 * How a message *looks* — and it looks like the canvas, on purpose.
 *
 * The feed and the DAG are two views of one orchestration, so they are one palette: the
 * colours below are the node colours (`canvas/theme.ts`), reused rather than re-picked. A
 * green `worker_done` chip and a green `completed` node mean the same thing, an amber
 * `decision_gate` and an amber `dispatched` node mean the same thing, and a red row and a red
 * node mean the same thing. Two palettes on one screen would be two vocabularies.
 *
 * Only the types the spec names get a colour. Anything else — `handoff`, `merge_ready`, a type
 * an Orca we have never seen invents — is rendered neutral with its raw name, which is the
 * same treatment an unknown task status gets (SPEC §5): shown, in a colour that claims nothing.
 */

/** The four types the feed shows by default, plus the one it hides (SPEC §7.7). */
const MESSAGE_COLORS: Record<string, StatusColor> = {
  worker_done: STATUS_COLORS.completed,
  escalation: STATUS_COLORS.failed,
  decision_gate: STATUS_COLORS.dispatched,
  status: STATUS_COLORS.pending,
  // Only ever on screen when the toggle asks for it. Blue: it means "still here", nothing more.
  heartbeat: STATUS_COLORS.ready,
};

export function colorOfMessage(type: string): StatusColor {
  return MESSAGE_COLORS[type] ?? UNKNOWN_STATUS_COLOR;
}

/**
 * ~1 s (SPEC §7.6). Long enough to catch the eye on a canvas you are already looking at,
 * short enough that a busy run does not become a strobe.
 */
export const PULSE_MS = 1000;

/**
 * The three types that pulse a node, and **the fact that nothing else does** — which is the
 * decision, not the colours.
 *
 * Heartbeats are 65% of all traffic and every one of them names a task (SPEC §7.7). Pulsing
 * them would flash the canvas continuously and mean nothing, so they do not pulse — their
 * liveness already reached the screen as the node's "last seen" badge. `status` does not
 * pulse either: the spec names three colours, and inventing a fourth would be inventing a
 * fourth meaning.
 *
 * A pulse says *something just happened here*. It is worth having only while it is rare.
 */
const PULSE_TYPES = ['worker_done', 'escalation', 'decision_gate'] as const;

export type Pulse = { type: string; color: string };

export function pulseOf(type: string): Pulse | null {
  if (!(PULSE_TYPES as readonly string[]).includes(type)) return null;
  return { type, color: colorOfMessage(type).border };
}

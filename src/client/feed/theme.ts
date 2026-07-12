import { STATUS_THEME, type StatusTheme, UNKNOWN_STATUS_THEME } from '../canvas/theme.ts';

/**
 * How a message *looks* — and it looks like the canvas, on purpose.
 *
 * The feed and the DAG are two views of one orchestration, so they are one palette: the entries
 * below are the *node* themes (`canvas/theme.ts`), reused rather than re-picked — the same class
 * string, so the two cannot drift. A green `worker_done` chip and a green `completed` node mean
 * the same thing, an amber `decision_gate` and an amber `dispatched` node mean the same thing,
 * and a red row and a red node mean the same thing. Two palettes on one screen would be two
 * vocabularies.
 *
 * Only the types the spec names get a colour. Anything else — `handoff`, `merge_ready`, a type
 * an Orca we have never seen invents — is rendered neutral with its raw name, which is the
 * same treatment an unknown task status gets (SPEC §5): shown, in a colour that claims nothing.
 */

/** What a message type looks like, and whether something *happening* is worth a flash. */
type MessageStyle = { theme: StatusTheme; pulses: boolean };

/**
 * One table, because "which colour" and "which types pulse" are one question asked twice —
 * kept apart, they are two places to edit when Orca invents a message type, and two chances
 * to disagree about what it means.
 *
 * **The `false`s are the decision, not the colours.** A pulse says *something just happened
 * here*, and it is worth having only while it is rare:
 *
 * - `heartbeat` is 65% of all traffic and every one of them names a task (SPEC §7.7). Pulsing
 *   them would flash the canvas continuously and say nothing — their liveness already reached
 *   the screen as the node's "last seen" badge (SPEC §4.6).
 * - `status` does not pulse either: the spec names three colours to flash in, and a fourth
 *   would be a fourth meaning nobody has agreed to.
 */
const MESSAGE_STYLES: Record<string, MessageStyle> = {
  worker_done: { theme: STATUS_THEME.completed, pulses: true },
  escalation: { theme: STATUS_THEME.failed, pulses: true },
  decision_gate: { theme: STATUS_THEME.dispatched, pulses: true },
  status: { theme: STATUS_THEME.pending, pulses: false },
  // Only ever on screen when the toggle asks for it. Blue: it means "still here", nothing more.
  heartbeat: { theme: STATUS_THEME.ready, pulses: false },
};

const UNKNOWN_MESSAGE_STYLE: MessageStyle = { theme: UNKNOWN_STATUS_THEME, pulses: false };

function styleOf(type: string): MessageStyle {
  return MESSAGE_STYLES[type] ?? UNKNOWN_MESSAGE_STYLE;
}

export function themeOfMessage(type: string): StatusTheme {
  return styleOf(type).theme;
}

/**
 * ~1 s (SPEC §7.6). Long enough to catch the eye on a canvas you are already looking at,
 * short enough that a busy run does not become a strobe.
 */
export const PULSE_MS = 1000;

export type Pulse = { type: string; color: string };

/** The flash a message leaves on its node — or null when its type is not worth flashing. */
export function pulseOf(type: string): Pulse | null {
  const style = styleOf(type);
  return style.pulses ? { type, color: style.theme.accent } : null;
}

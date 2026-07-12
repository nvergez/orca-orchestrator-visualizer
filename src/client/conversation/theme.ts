import { GATE_THEME, STATUS_THEME, type StatusTheme, UNKNOWN_STATUS_THEME } from '../canvas/theme.ts';

/**
 * How a turn *looks* — and it looks like the canvas, on purpose.
 *
 * The conversation and the DAG are two views of one orchestration, so they are one palette: the
 * entries below are the *node* themes (`canvas/theme.ts`), reused rather than re-picked — the same
 * class string, so the two cannot drift. A green `worker_done` and a green `completed` node mean
 * the same thing; an orange gate in the thread and the orange octagon on the node are the same
 * question. Two palettes on one screen would be two vocabularies.
 *
 * Only the kinds the spec names get a colour. Anything else — `handoff`, `merge_ready`, a type an
 * Orca we have never seen invents — is rendered neutral with its raw name, which is the same
 * treatment an unknown task status gets (SPEC §5): shown, in a colour that claims nothing.
 */

/** What a turn looks like, and whether something *happening* is worth a flash on its node. */
type TurnStyle = { theme: StatusTheme; pulses: boolean };

/**
 * One table, because "which colour" and "which kinds pulse" are one question asked twice — kept
 * apart, they are two places to edit when Orca invents a message type, and two chances to disagree
 * about what it means.
 *
 * **The `false`s are the decision, not the colours.** A pulse says *something just happened here*,
 * and it is only worth having while it is rare:
 *
 * - `heartbeat` is 65% of all traffic and every one names a task (SPEC §7.7). Pulsing them would
 *   flash the canvas continuously and say nothing — their liveness already reached the screen as
 *   the agent's "last seen" badge (SPEC §4.6).
 * - `dispatch` and `result` never pulse because **they never *arrive***. They are reconstructions
 *   of columns (SPEC §4.7), not events on a wire; a node cannot flash at the moment a row it has
 *   always held was read.
 * - `status` does not pulse either: the spec names three colours to flash in, and a fourth would
 *   be a fourth meaning nobody has agreed to.
 */
const TURN_STYLES: Record<string, TurnStyle> = {
  // The orchestrator handing out work — amber, the colour of work in flight.
  dispatch: { theme: STATUS_THEME.dispatched, pulses: false },
  status: { theme: STATUS_THEME.pending, pulses: false },
  worker_done: { theme: STATUS_THEME.completed, pulses: true },
  escalation: { theme: STATUS_THEME.failed, pulses: true },
  // The orange of a *stopped* orchestration — the same one the node's octagon and the strip above
  // the canvas wear, and deliberately not the amber of `dispatched`: amber is work in flight, and
  // a gate is the exact opposite of that (`GATE_THEME`).
  decision_gate: { theme: GATE_THEME, pulses: true },
  // The orchestrator answering: not "done" (green already means the *work* finished) and no longer
  // "blocked". Blue is the colour of a thing that is now free to proceed.
  answer: { theme: STATUS_THEME.ready, pulses: false },
  result: { theme: STATUS_THEME.completed, pulses: false },
  heartbeat: { theme: STATUS_THEME.ready, pulses: false },
  heartbeats: { theme: STATUS_THEME.ready, pulses: false },
};

const UNKNOWN_TURN_STYLE: TurnStyle = { theme: UNKNOWN_STATUS_THEME, pulses: false };

function styleOf(kind: string): TurnStyle {
  return TURN_STYLES[kind] ?? UNKNOWN_TURN_STYLE;
}

export function themeOfTurn(kind: string): StatusTheme {
  return styleOf(kind).theme;
}

/**
 * ~1 s (SPEC §7.6). Long enough to catch the eye on a canvas you are already looking at, short
 * enough that a busy run does not become a strobe.
 */
export const PULSE_MS = 1000;

export type Pulse = { type: string; color: string };

/** The flash a message leaves on its node — or null when its type is not worth flashing. */
export function pulseOf(type: string): Pulse | null {
  const style = styleOf(type);
  return style.pulses ? { type, color: style.theme.accent } : null;
}

import { MotionGlobalConfig, type Transition, type Variants } from 'motion/react';

/**
 * How this page moves (SPEC §7.9) — the seam that keeps every animation in the tool speaking
 * with one accent, the way `canvas/theme.ts` keeps every status speaking in one colour.
 *
 * The rule underneath all of it: **if it moves, it is happening.** A ring spins because an agent
 * is inside that node right now; a dot pings because a run has not finished; a strip breathes
 * because a question is unanswered. Motion is a *channel*, and a channel you spend on decoration
 * is a channel you cannot spend on meaning — so everything that is merely arriving on screen gets
 * one short, calm entrance and then holds perfectly still.
 *
 * The durations are short on purpose. This is a panel you watch for an hour, not a landing page
 * you scroll once: an animation you notice the second time is an animation that is too long.
 */

/**
 * The state a thing enters *from* — or `false`, meaning it does not enter at all: motion renders
 * it straight at its final state, on the first frame, done.
 *
 * Every entrance in this tool goes through here, and that is the point. An entrance starts at
 * `opacity: 0`, so anything that decides "no animations" has to be able to say so **before** the
 * first paint — otherwise the panel is invisible until a frame runs, and there are two situations
 * where no frame is coming:
 *
 * - **The suite.** `test/client/setup.ts` sets `skipAnimations`, and the assertions are synchronous:
 *   a heading checked for visibility the instant it renders would be checked against frame one of
 *   a perfectly good fade.
 * - **Anyone who turns animations off globally.** `MotionGlobalConfig.skipAnimations` is motion's
 *   own switch, and a tool that honoured it by *hiding its own panels* would be a tool that broke
 *   when asked to hold still.
 *
 * So it is read at render, not cached at module load: the flag is a decision about this paint.
 */
export function enter<T>(from: T): T | false {
  return MotionGlobalConfig.skipAnimations ? false : from;
}

/** Panels, docks, anything with weight. Settles without wobbling — furniture does not bounce. */
export const SPRING: Transition = { type: 'spring', stiffness: 380, damping: 34, mass: 0.9 };

/** A row landing in a list. Snappier, because a hundred of them will do it. */
export const SPRING_FAST: Transition = { type: 'spring', stiffness: 520, damping: 40, mass: 0.6 };

/** Colour, opacity, a highlight sliding between rows — things with no mass to simulate. */
export const EASE: Transition = { duration: 0.2, ease: [0.22, 1, 0.36, 1] };

/**
 * A node arriving on the canvas once elkjs has said where it goes.
 *
 * The blur is what makes it read as *resolving* rather than sliding: the graph is being worked
 * out, and then it is worked out. It is capped hard by `nodeDelay` below, because 72 nodes × a
 * naive per-index stagger is a canvas that takes four seconds to become readable.
 */
export const NODE_IN: Variants = {
  hidden: { opacity: 0, scale: 0.92, filter: 'blur(6px)' },
  shown: { opacity: 1, scale: 1, filter: 'blur(0px)' },
  /**
   * **An agent is selected, and this node is not theirs** (SPEC §7.5).
   *
   * It is a *variant* and not a Tailwind class, and that is not a style preference — it is the only
   * thing that works. `shown` writes `opacity: 1` into the element's inline style, and an inline
   * style beats a class, so an `opacity-20` on the same node would be silently overridden and the
   * canvas would never dim at all. The two states have to live in the same system to be able to
   * argue.
   *
   * Faded, never hidden: the shape of the orchestration survives the filter, so you can still see
   * *where* your agent's work sat inside it — which is the entire difference between focusing a
   * canvas and emptying one.
   */
  dimmed: { opacity: 0.18, scale: 1, filter: 'blur(0px)' },
};

/**
 * The whole canvas is drawn in under a third of a second however big the run is. A stagger that
 * scales with the node count is a stagger that punishes exactly the runs most worth looking at.
 */
export function nodeDelay(index: number): number {
  return Math.min(index * 0.012, 0.28);
}

/** A dock panel swapping in (conversation ⇄ inspector) — it comes from the edge it lives on. */
export const DOCK_IN: Variants = {
  hidden: { opacity: 0, x: 18 },
  shown: { opacity: 1, x: 0 },
  gone: { opacity: 0, x: 18 },
};

/**
 * A dock panel arriving on the folded shell (below `lg`) — it rises from the bottom edge it
 * lives on, exactly as DOCK_IN comes from the right edge it lives on. Collapse is instant, for
 * the same reason dock exits are instant (`App.tsx`): animating a fold is animating the user's
 * own tap back at them.
 */
export const BAND_IN: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0 },
};

/** A row that arrives in a list, pushing the rest along (the `layout` prop does the push). */
export const ROW_IN: Variants = {
  hidden: { opacity: 0, y: -12 },
  shown: { opacity: 1, y: 0 },
  gone: { opacity: 0 },
};

/** A section of the inspector, in the order a post-mortem reads them. */
export const SECTION_IN: Variants = {
  hidden: { opacity: 0, y: 8 },
  shown: (index: number) => ({ opacity: 1, y: 0, transition: { ...EASE, delay: Math.min(index * 0.04, 0.24) } }),
};

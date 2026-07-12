import { useCallback, type CSSProperties, type MouseEvent } from 'react';
import { cn } from '@/lib/utils';

/**
 * The cursor-follow highlight — a card that knows where you are pointing at it.
 *
 * It is one idea used in four places (a task node, a run row, a feed row, a dispatch attempt), and
 * it is here rather than copied into each of them for the reason `theme.ts` exists: four
 * implementations of the same gesture would be four gestures.
 *
 * **It never re-renders.** The obvious way to write this — pointer position in `useState` — costs
 * a React render per pixel of pointer travel, and this canvas has seventy-odd nodes on it. So the
 * handler writes the coordinates straight onto the element's own style as custom properties, and
 * the gradient in `index.css` reads them. React is not told, because React has nothing to do.
 *
 * The colour is the caller's: a node lights up in its *status*, so a failed node glows red and a
 * completed one green, and the highlight is one more place the palette means what it says.
 */

export type SpotlightProps = {
  /** A `var(--…)` value or any CSS colour. Defaults to the foreground — used by the neutral rows. */
  colour?: string;
  className?: string;
};

/**
 * The layer itself. Absolutely positioned, `pointer-events: none`, and **first among the card's
 * children**, so it paints over the card's own background and under everything with something to
 * say. The card it sits in must be `relative` and must be a `group`.
 */
export function Spotlight({ colour, className }: SpotlightProps) {
  return (
    <span
      aria-hidden
      className={cn('orca-spotlight', className)}
      style={colour ? ({ ['--orca-spotlight-colour' as string]: colour } as CSSProperties) : undefined}
    />
  );
}

/**
 * The handler that feeds it. Spread onto the same element the `<Spotlight/>` is a child of:
 *
 * ```tsx
 * <div className="group relative" {...useSpotlight()}>
 *   <Spotlight colour={theme.accent} />
 *   …
 * </div>
 * ```
 */
export function useSpotlight(): { onMouseMove: (event: MouseEvent<HTMLElement>) => void } {
  const onMouseMove = useCallback((event: MouseEvent<HTMLElement>) => {
    const card = event.currentTarget;
    const box = card.getBoundingClientRect();

    // Percentages, not pixels: the gradient is positioned in the element's own box, and a node
    // React Flow has scaled to 40% would otherwise light up somewhere off its own corner.
    card.style.setProperty('--mx', `${((event.clientX - box.left) / box.width) * 100}%`);
    card.style.setProperty('--my', `${((event.clientY - box.top) / box.height) * 100}%`);
  }, []);

  return { onMouseMove };
}

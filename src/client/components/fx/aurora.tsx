import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

/**
 * A slow, coloured light behind a surface — the aurora (SPEC §7.9).
 *
 * There is exactly one place in this tool that earns it: **the strip above the canvas that says
 * your orchestration has stopped and is waiting on you.** Everything else on the page is a fact
 * you read; that strip is a fact that is *waiting*, and a light that will not sit still is what a
 * thing that will not go away looks like.
 *
 * Three blurred blobs of the gate's own orange, drifting out of phase behind a translucent
 * surface. Deliberately slow — 18 to 26 seconds a cycle — because the strip has to be noticeable
 * for as long as the gate is open, and anything faster becomes a thing you want to close.
 */

export type AuroraProps = {
  /** A `var(--…)` value. The gate's orange, when the gate is what is glowing. */
  colour: string;
  className?: string;
};

/** Three blobs, three speeds, three corners — enough that the loop never lines up visibly. */
const BLOBS: { style: CSSProperties; className: string }[] = [
  {
    className: 'left-[-10%] top-[-120%] h-[320%] w-[45%]',
    style: { animationDuration: '19s' },
  },
  {
    className: 'left-[30%] top-[-140%] h-[340%] w-[38%]',
    style: { animationDuration: '25s', animationDelay: '-7s' },
  },
  {
    className: 'right-[-8%] top-[-110%] h-[300%] w-[42%]',
    style: { animationDuration: '22s', animationDelay: '-13s' },
  },
];

export function Aurora({ colour, className }: AuroraProps) {
  return (
    <span aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {BLOBS.map((blob, index) => (
        <span
          key={index}
          className={cn('absolute rounded-full blur-3xl', blob.className)}
          style={{
            ...blob.style,
            // A fifth strength, and that is already generous. This sits *behind* the question you
            // have to read: it has to be enough that the strip is never still, and not one step
            // more, because a background that competes with its own foreground has failed at
            // being a background. (It was tuned to 42% first, and on the real gate strip that
            // read as *on fire* rather than *waiting* — which is a different thing to say.)
            background: `radial-gradient(closest-side, color-mix(in oklch, ${colour} 20%, transparent), transparent)`,
            animationName: 'orca-drift',
            animationTimingFunction: 'ease-in-out',
            animationIterationCount: 'infinite',
          }}
        />
      ))}
    </span>
  );
}

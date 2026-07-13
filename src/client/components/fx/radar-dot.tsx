import { cn } from '@/lib/utils';

/**
 * *This is not finished.*
 *
 * The page's one repeating gesture, and it turns up in the three places that fact does: the
 * liveness pill in the top bar, an active run on the rail, and the status dot of a task an agent
 * is currently working inside. One component, so that a reader who learns what the ring means in
 * the rail already knows what it means on the canvas (SPEC §7.9).
 *
 * Two rings, out of phase, so it reads as a repeating *sweep* rather than a blink. A silent or
 * finished run's dot is the same dot, and it holds perfectly still — which is the whole of the
 * signal.
 */

export type RadarDotProps = {
  live: boolean;
  /** The fill, as a Tailwind class. Green in the shell; the task's own status on a node. */
  fill?: string;
  className?: string;
};

export function RadarDot({ live, fill = 'bg-status-completed', className }: RadarDotProps) {
  const dead = 'bg-muted-foreground/40';

  return (
    <span aria-hidden className={cn('relative size-1.5 shrink-0 rounded-full', live ? fill : dead, className)}>
      {live && (
        <>
          <span className={cn('absolute inset-0 rounded-full', fill)} style={{ animation: 'orca-radar 2s ease-out infinite' }} />
          <span
            className={cn('absolute inset-0 rounded-full', fill)}
            style={{ animation: 'orca-radar 2s ease-out 1s infinite' }}
          />
        </>
      )}
    </span>
  );
}

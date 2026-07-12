import { cn } from '@/lib/utils';

/**
 * Falling light, behind the splash (SPEC §7.9).
 *
 * This is the one screen in the tool with **no data on it** — the half-second before the first
 * `StreamEvent` lands (`Live.tsx`) — and so it is the one screen where a purely beautiful thing
 * costs nothing. Nothing is being obscured, because there is nothing there yet.
 *
 * The offsets are a fixed table rather than `Math.random()`: a background that is a different
 * background on every mount is a background that shows up in a diff of two screenshots, and this
 * one has to be able to sit still in a test.
 */

/** left %, delay s, duration s, opacity — spread wide, out of phase, three depths. */
const BEAMS: [number, number, number, number][] = [
  [6, 0, 3.2, 0.5],
  [17, 1.4, 4.6, 0.28],
  [29, 0.5, 3.8, 0.7],
  [38, 2.6, 5.2, 0.22],
  [50, 1.1, 3.4, 0.55],
  [61, 3.1, 4.9, 0.3],
  [72, 0.2, 4.1, 0.62],
  [84, 2.1, 3.6, 0.35],
  [93, 1.8, 5.5, 0.24],
];

export function Beams({ className }: { className?: string }) {
  return (
    <span aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {BEAMS.map(([left, delay, duration, opacity]) => (
        <span
          key={left}
          className="absolute top-0 h-[28%] w-px"
          style={{
            left: `${left}%`,
            opacity,
            background: 'linear-gradient(to bottom, transparent, var(--selection), transparent)',
            animation: `orca-beam ${duration}s linear ${delay}s infinite`,
          }}
        />
      ))}
    </span>
  );
}

import { Archive, Waypoints } from 'lucide-react';
import { motion } from 'motion/react';
import { Beams } from '@/components/fx/beams';
import { cn } from '@/lib/utils';
import { enter, SPRING } from './motion.ts';
import { FIELD_BACKDROP_STYLE } from './surface.ts';

/**
 * **The one screen in this tool with no data on it** — and therefore the one screen where a purely
 * beautiful thing costs nothing at all: there is nothing here to obscure, no status to compete
 * with, and no number anybody is trying to read. So it gets the beams, the glow and the sweep of
 * light across the word — and it gets them for half a second, once, and then the tool starts.
 *
 * It is one component and not two because the *only* thing that differs between the live tool
 * opening a database and a replay opening a file is the sentence, and the sentence is the one
 * thing that must not be wrong: an archived replay that flashed "Connecting to the database…"
 * would be claiming, for one frame, exactly the thing an archive exists never to claim (#74).
 */
export function Splash({ archived = false }: { archived?: boolean }) {
  return (
    <main className="bg-field relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute inset-0" style={FIELD_BACKDROP_STYLE} />
      <Beams />

      <motion.span
        initial={enter({ opacity: 0, scale: 0.8 })}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className={cn(
          'relative flex size-11 items-center justify-center rounded-2xl',
          // The archived mark is muted and the live one glows, for the same reason the bars differ:
          // on this page, light means something is running.
          archived ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'
        )}
        style={
          archived ? undefined : { boxShadow: '0 0 60px -10px var(--selection), 0 0 0 1px oklch(1 0 0 / 0.08)' }
        }
      >
        {archived ? <Archive className="size-5.5" /> : <Waypoints className="size-5.5" />}
      </motion.span>

      <motion.h1
        initial={enter({ opacity: 0, y: 6 })}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING, delay: 0.08 }}
        className="relative text-base font-semibold tracking-tight"
      >
        orca-viz
      </motion.h1>

      {/* A sweep of light across the sentence, rather than a sentence blinking on and off: it is
          reading a file, and reading is a thing that moves in one direction. */}
      <motion.p
        initial={enter({ opacity: 0 })}
        animate={{ opacity: 1 }}
        transition={{ ...SPRING, delay: 0.16 }}
        className="relative bg-clip-text text-xs text-transparent"
        style={{
          backgroundImage:
            'linear-gradient(90deg, var(--muted-foreground) 40%, var(--foreground) 50%, var(--muted-foreground) 60%)',
          backgroundSize: '200% 100%',
          animation: 'orca-shimmer 1.8s linear infinite',
        }}
      >
        {archived ? 'Opening the archive…' : 'Connecting to the database…'}
      </motion.p>
    </main>
  );
}

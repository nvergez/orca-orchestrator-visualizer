import { Database, Moon, Sun, Waypoints } from 'lucide-react';
import { motion } from 'motion/react';
import { Beams } from '@/components/fx/beams';
import { RadarDot } from '@/components/fx/radar-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { Meta } from '../../shared/types.ts';
import { livenessSentence, schemaSentence } from '../../shared/wording.ts';
import { GATE_THEME } from '../canvas/theme.ts';
import { type Connection, CONNECTION_WORDING } from '../connection.ts';
import { EASE, enter, SPRING } from '../motion.ts';
import { relativeTime, useClock } from '../relative-time.ts';
import { FIELD_BACKDROP_STYLE, PANEL_CLASS } from '../surface.ts';
import { useThemeMode } from '../theme-mode.ts';

/**
 * **The chrome every screen wears** — the field it stands on, the bar that says what is being
 * read, the notices that say what is wrong with it, and the screen before the first event lands.
 *
 * None of it is about the DAG, and that is why it is here rather than in `App.tsx`. Both screens
 * this application has make the *same four claims* about the same database — which file, how old
 * the page's copy of it is, what the transport is doing, and whether Orca is still writing — and
 * the kiosk (#62) is a wall display, where those claims matter *more* than they do at a desk: a
 * reader ten feet away cannot check the connection by clicking anything.
 *
 * So they are one implementation, imported twice. Two copies of the liveness pill would be two
 * pills that could disagree about what "live" means, and a wall that quietly disagrees with the
 * screen beside it is worse than no wall at all.
 */

/**
 * The field the panels stand on: a fine grid, and a soft glow above the work (SPEC §7.9).
 *
 * It is the cheapest thing in the whole redesign and it does the most — a grid says *surface with
 * coordinates* before a single node has drawn, which is exactly what this tool is looking at.
 */
export function Backdrop() {
  return <span aria-hidden className="pointer-events-none absolute inset-0 -z-10" style={FIELD_BACKDROP_STYLE} />;
}

/**
 * The one bar across the top, and everything on it is an answer to *what am I actually looking
 * at*: which database, how old it is, and whether anything is still writing to it.
 *
 * It is not a toolbar. There is nothing to do to an Orca database from here — this tool does not
 * write (SPEC §1.2) — so the only control on it is the one that is about the reader and not the
 * data: the light the page is read in.
 */
export function TopBar({ meta, connection, appliedAt }: { meta: Meta; connection: Connection; appliedAt: number | null }) {
  return (
    <motion.header
      initial={enter({ opacity: 0, y: -8 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        PANEL_CLASS,
        'flex h-13 shrink-0 items-center gap-3 px-4',
        // Below `lg` the bar may grow a line: the liveness sentence is spec-pinned content
        // (SPEC §6.1) and wraps rather than being cut, so the bar pays the height.
        'max-lg:h-auto max-lg:min-h-13 max-lg:py-2 max-lg:landscape:min-h-11 max-lg:landscape:py-1'
      )}
    >
      <span className="flex shrink-0 items-center gap-2">
        <span
          className="bg-primary text-primary-foreground flex size-6 items-center justify-center rounded-md"
          // The mark is the one thing on the page that is allowed to be simply *nice*: it names
          // the tool and reports nothing, so a glow on it costs no channel.
          style={{ boxShadow: '0 0 18px -4px var(--selection)' }}
        >
          <Waypoints className="size-3.5" />
        </span>
        {/* On the fold the mark alone identifies: the wordmark and the ornament beside it are
            the first things a 390px bar cannot afford. */}
        <b className="text-sm font-semibold tracking-tight whitespace-nowrap max-lg:hidden">orca-viz</b>
      </span>

      <Separator orientation="vertical" className="!h-5 max-lg:hidden" />

      <Status meta={meta} />

      <StreamPill connection={connection} />

      <Source meta={meta} appliedAt={appliedAt} />

      <ThemeToggle />
    </motion.header>
  );
}

/**
 * The top bar's pill — one shape for the two status pills standing beside each other, so they
 * cannot drift apart (the doctrine of `chip.ts`: one class string, in one place). And one quiet
 * state shared between them, because "nothing is wrong, nothing is news" should look the same
 * whichever fact is saying it.
 */
const PILL_CLASS = 'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium';
const PILL_QUIET_CLASS = 'text-muted-foreground bg-muted border-transparent';

/**
 * Live, or last-known — the one thing that is always worth saying, said in the words the
 * spec pins down (SPEC §6.1). `src/shared/wording.ts` owns the sentence, so this and the
 * line the terminal prints at boot are the same sentence and cannot drift apart.
 *
 * The dot **radars** when it is live, which is the same gesture the rail's live run and a
 * dispatched node's status dot both wear: on this page, a ring going out means *this is not
 * finished* (SPEC §7.9).
 */
function Status({ meta }: { meta: Meta }) {
  const live = meta.liveness === 'live';

  return (
    <p
      role="status"
      data-state={meta.liveness}
      className={cn(
        PILL_CLASS,
        // `max-lg:shrink` lets the pill compress and the sentence *wrap* — never truncate: the
        // wording is the spec's, and the words are content, not decoration.
        'max-lg:min-w-0 max-lg:shrink',
        live ? 'bg-status-completed-soft text-status-completed-ink border-status-completed/50' : PILL_QUIET_CLASS
      )}
      style={
        live
          ? { boxShadow: '0 0 16px -6px color-mix(in oklch, var(--status-completed) 90%, transparent)' }
          : undefined
      }
    >
      <RadarDot live={live} />
      {/* The sentence is the spec's, down to the word (`wording.ts`) — the capital is the
          stylesheet's, because a sentence in a pill still starts like a sentence. */}
      <span className="first-letter:uppercase">{livenessSentence(meta, formatTime)}.</span>
    </p>
  );
}

/**
 * What the *transport* is doing (#57) — beside the liveness pill, and deliberately not part of
 * it: "is Orca writing to the database" and "is this page still receiving what the server reads
 * from it" are independent facts, and the screen must be able to say any combination of them.
 * The `EventSource` retries a dropped stream on its own (`Live.tsx`), so `reconnecting` is a
 * narration and never a call to action — it wears the amber of work in flight, because that is
 * what a retry is, and `connected` stays quiet: a healthy transport is not news.
 */
function StreamPill({ connection }: { connection: Connection }) {
  return (
    <p
      role="status"
      data-testid="stream-state"
      data-state={connection}
      className={cn(
        PILL_CLASS,
        connection === 'reconnecting'
          ? 'bg-status-dispatched-soft text-status-dispatched-ink border-status-dispatched/50'
          : PILL_QUIET_CLASS
      )}
    >
      {CONNECTION_WORDING[connection]}
    </p>
  );
}

/** Always on screen, always true: the file, and the schema it turned out to be. */
function Source({ meta, appliedAt }: { meta: Meta; appliedAt: number | null }) {
  return (
    <dl className="text-muted-foreground ml-auto flex min-w-0 items-center gap-3 text-[11px]">
      {/* Long, and always worth having: the whole of it is in the tooltip, because "which
          database am I reading" is the one question this bar exists to answer. */}
      <div className="flex min-w-0 items-center gap-1.5" title={meta.dbPath}>
        <dt className="sr-only">Database</dt>
        <Database aria-hidden className="size-3.5 shrink-0 opacity-70" />
        <dd className="m-0 max-w-[26rem] min-w-0 max-lg:max-w-[30vw]">
          <code className="block truncate font-mono">{meta.dbPath}</code>
        </dd>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <dt className="sr-only">Schema</dt>
        <dd className="m-0">
          <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
            v{meta.schemaVersion}
          </Badge>
        </dd>
      </div>

      <div className="hidden shrink-0 items-center gap-1.5 lg:flex" title="When this database was last written to">
        <dt className="opacity-70">Last write</dt>
        <dd className="m-0 tabular-nums">{formatTime(meta.dbMtime)}</dd>
      </div>

      {appliedAt !== null && <DataAge appliedAt={appliedAt} />}
    </dl>
  );
}

/**
 * How often the data age re-reads the wall clock (#57). The acceptance bar is "advances at
 * least every 30 seconds without a new event"; 10 s keeps the readout feeling attended without
 * waking the page often enough to matter.
 */
const DATA_AGE_TICK_MS = 10_000;

/**
 * How long ago this page applied its last snapshot (#57) — on a wall clock of its own, so it
 * keeps advancing when the stream goes quiet. Which is the point: a quiet connected stream is
 * a quiet orchestration, and the honest way to show one is a green pill beside a growing age.
 *
 * It measures the *apply*, nothing else. Not the connection (that is the pill's), not the
 * database's last write (that is `Last write`, from the file's own mtime), and never a claim
 * that anything is stale — the tooltip says so, because this is the number most tempting to
 * misread. Rendered only when an apply has actually been observed (`appliedAt`, `Live.tsx`):
 * before the first one there is no age to show, and nothing is shown.
 *
 * Its clock lives here, in the one component that reads it, so the ten-second tick re-renders
 * this `<div>` and not the shell (`useClock`).
 */
function DataAge({ appliedAt }: { appliedAt: number }) {
  const now = useClock(DATA_AGE_TICK_MS);

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      title="How long ago this page applied a snapshot from the stream. A quiet stream is not a stale database — a growing age beside a connected stream just means nothing new was written."
    >
      <dt className="opacity-70">Data age</dt>
      <dd className="m-0 tabular-nums" data-testid="data-age">
        {relativeTime(now - appliedAt)}
      </dd>
    </div>
  );
}

function ThemeToggle() {
  const { mode, toggle } = useThemeMode();

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      className="text-muted-foreground hover:text-foreground size-7 shrink-0 cursor-pointer pointer-coarse:size-10"
      aria-label={mode === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
      title={mode === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
    >
      <motion.span
        key={mode}
        initial={enter({ opacity: 0, rotate: -90, scale: 0.6 })}
        animate={{ opacity: 1, rotate: 0, scale: 1 }}
        transition={EASE}
        className="flex items-center justify-center"
      >
        {mode === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </motion.span>
    </Button>
  );
}

/**
 * The things that are *wrong*, in the order they change what you should believe about the
 * screen. Nothing renders when there is nothing to say: a banner that is always there is
 * furniture, and furniture stops being read.
 */
export function Notices({ meta }: { meta: Meta }) {
  const schema = schemaSentence(meta);
  if (schema === null && !meta.resetDetected) return null;

  return (
    <motion.div
      initial={enter({ opacity: 0, y: -6 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        'flex shrink-0 flex-col gap-px overflow-hidden rounded-xl border text-xs shadow-lift-1',
        // A long degraded list scrolls internally on the fold instead of eating the canvas —
        // capped, never truncated: the notices are content (canon trap 8).
        'max-lg:max-h-24 max-lg:overflow-y-auto max-lg:landscape:max-h-16',
        GATE_THEME.surface
      )}
    >
      {/*
       * The schema banner (#21) — one banner for both directions of drift, because they are
       * the same fact told from two sides: this database is not the one the build was written
       * for. A newer Orca gets the warning and nothing else; an older one gets the list of
       * what a missing column cost, so a badge that never renders is *explained* rather than
       * looking like a bug. That is the whole point of `meta.degraded` reaching the screen.
       */}
      {schema !== null && (
        <section role="status" data-state={`schema-${meta.schemaSupport}`} className="px-4 py-2">
          <p>
            {schema} <span className="opacity-70">(schema v{meta.schemaVersion})</span>
          </p>

          {meta.degraded.length > 0 && (
            <ul className="mt-1 list-disc pl-5 opacity-90">
              {meta.degraded.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {meta.resetDetected && (
        <p role="status" data-state="reset" className="px-4 py-2">
          Some history is gone: an <code className="font-mono font-semibold">orchestration reset</code> wiped messages
          this database once held.
        </p>
      )}
    </motion.div>
  );
}

/**
 * Before the first `StreamEvent` lands (`Live.tsx`) — which, on a local file, is one blink.
 *
 * **The one screen in this tool with no data on it**, and therefore the one screen where a purely
 * beautiful thing costs nothing at all: there is nothing here to obscure, no status to compete
 * with, and no number anybody is trying to read. So it gets the beams, the glow and the sweep of
 * light across the word — and it gets them for half a second, once, and then the tool starts.
 */
export function Connecting() {
  return (
    <main className="bg-field relative flex h-full flex-col items-center justify-center gap-4 overflow-hidden">
      <span aria-hidden className="pointer-events-none absolute inset-0" style={FIELD_BACKDROP_STYLE} />
      <Beams />

      <motion.span
        initial={enter({ opacity: 0, scale: 0.8 })}
        animate={{ opacity: 1, scale: 1 }}
        transition={SPRING}
        className="bg-primary text-primary-foreground relative flex size-11 items-center justify-center rounded-2xl"
        style={{ boxShadow: '0 0 60px -10px var(--selection), 0 0 0 1px oklch(1 0 0 / 0.08)' }}
      >
        <Waypoints className="size-5.5" />
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
        Connecting to the database…
      </motion.p>
    </main>
  );
}

/** An instant a person can place, in their own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

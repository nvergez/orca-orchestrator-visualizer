import { OctagonAlert } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import type { StreamEvent } from '../../shared/types.ts';
import { SessionActivity } from '../activity/SessionActivity.tsx';
import { type AttentionItem, deriveAttention } from '../attention.ts';
import { AttentionQueue, KIND_LOOK } from '../attention/AttentionQueue.tsx';
import { GATE_THEME } from '../canvas/theme.ts';
import type { Connection } from '../connection.ts';
import { HealthDot, HEALTH_WORDS } from '../health-dot.tsx';
import { enter, SPRING } from '../motion.ts';
import { statusBreakdown } from '../rail/summary.ts';
import { relativeTime, useNow } from '../relative-time.ts';
import { Backdrop, Connecting, Notices, TopBar } from '../shell/chrome.tsx';
import { FIELD_CLASS, PANEL_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { STALE_WORKER_INK } from '../worker-health.ts';
import { type KioskTile, unfinishedRuns } from './unfinished.ts';

/**
 * **The kiosk** (#62): the same database, on a wall, answering one question — *what is unfinished,
 * and is anything stopping it.*
 *
 * It is a **route in this application and not a mode of it** (`route.ts`). No second process, no
 * flag, no second bundle, and nothing on the server knows it exists. What makes it a kiosk is
 * entirely what it *leaves out*: there is no DAG here, no inspector, no conversation, no browser
 * for finished work, and nothing at all to click that would change a thing in Orca — this tool
 * never writes (SPEC §1.2), and a screen nobody is standing at is the last place to start.
 *
 * **Everything it says, the main screen says too, in the same words.** That is the whole design
 * constraint, and it is why so little code lives here: the tiles come out of one derivation
 * (`unfinished.ts`) built on #48's run health, #47's worker health and #45's `blocking`; the queue
 * is `deriveAttention` (#56), ranked and worded by the same function that ranks and words it on the
 * rail; the top bar is the shell's, so the transport state, the data age (#57) and the schema
 * notices are literally the same components. A wall that quietly disagreed with the screen beside
 * it would be worse than no wall, and the way to make that impossible is to have no second copy of
 * anything to disagree *with*.
 *
 * **And it never asks for the screen.** No `requestFullscreen`, no wake lock, no rotation, no
 * saved layout: those are the display's business and its owner's, and a page that grabbed the
 * screen on load would be a page you could not put on a wall beside anything else.
 */

const NO_TILES: KioskTile[] = [];
const NO_ATTENTION: AttentionItem[] = [];

/**
 * What an empty queue *means*, spelled out — named from the queue's own table (`KIND_LOOK`), so
 * the sentence is a list of the causes actually looked for and not a list somebody typed once.
 *
 * A sixth cause added to `attention.ts` cannot compile without an entry in that table, and the
 * moment it has one this sentence names it too. Hard-coded prose would instead go on quietly
 * promising a wall that five things had been checked while six were being derived.
 */
const NOTHING_FOUND = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
  Object.values(KIND_LOOK).map((look) => `no ${look.label}`)
);

export type KioskProps = {
  event: StreamEvent | null;
  /** What the transport is doing (#57) — `Live.tsx` tells both screens, and they wear it alike. */
  connection?: Connection;
  /** When this page last applied a snapshot (#57), in epoch ms of this machine's clock. */
  appliedAt?: number | null;
};

export function Kiosk({ event, connection = 'connected', appliedAt = null }: KioskProps) {
  // The one clock, ticking on its own (`WALL_CLOCK_TICK_MS`) — which is the whole of what makes a
  // wall display honest. A run crosses `active → silent` and a failure ages out of the queue
  // because *time passed*, and a quiet database pushes nothing at all to notice it with: a kiosk
  // reading the clock only on pushes would sit there all night showing a ten-hour-old "active".
  const now = useNow(event);

  const tiles = useMemo(() => (event ? unfinishedRuns(event.snapshot, now) : NO_TILES), [event, now]);
  const attention = useMemo(() => (event ? deriveAttention(event.snapshot, now) : NO_ATTENTION), [event, now]);

  if (!event) return <Connecting />;

  // What is *not* on the wall, said out loud. A supervisor who knows a run exists and cannot find
  // it must be told why it is missing, or the wall is lying by omission — and "it converged" is a
  // complete answer. It is a count and not a list: a browser for finished work is the other screen.
  const finished = event.snapshot.runs.length - tiles.length;

  return (
    <MotionConfig reducedMotion="user">
      <main data-testid="kiosk" className={FIELD_CLASS}>
        <Backdrop />

        <TopBar meta={event.meta} connection={connection} appliedAt={appliedAt} />

        <Notices meta={event.meta} />

        <div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col">
          <section className={cn(PANEL_CLASS, 'flex min-w-0 flex-1 flex-col overflow-hidden')}>
            <div className={cn(PANEL_HEADER_CLASS, 'flex-row items-center gap-2')}>
              <h2 className={PANEL_TITLE_CLASS}>Unfinished orchestrations</h2>
              <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">{tiles.length}</span>
            </div>

            {tiles.length === 0 ? (
              <Nothing runs={event.snapshot.runs.length} />
            ) : (
              <>
                {/* Tiles, not rows: a wall is read from across a room, and the grid grows a column
                    as the display does rather than stretching four facts across a metre of glass. */}
                <ul className="grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto p-2 sm:grid-cols-2 2xl:grid-cols-3">
                  {tiles.map((tile) => (
                    <Tile key={tile.run.id} tile={tile} />
                  ))}
                </ul>

                {finished > 0 && <FinishedNote finished={finished} />}
              </>
            )}
          </section>

          {/*
            The attention queue (#56), whole — the same items, in the same order, with the same
            explanations the rail shows, because it is the same function and the same component.
            It is a column of its own here rather than a strip above a list: on a wall this *is*
            the headline, and the tiles are the context it lands in.
          */}
          <aside
            data-testid="kiosk-attention"
            aria-label="Needs attention"
            className={cn(PANEL_CLASS, 'flex w-[22rem] shrink-0 flex-col overflow-hidden max-lg:w-full')}
          >
            {attention.length === 0 ? (
              // The queue itself renders nothing when nothing needs attention — which is right on a
              // rail, where the orchestrator list stands underneath and the absence speaks for
              // itself. On a wall an empty column says nothing at all, and "is it broken, or is it
              // fine?" is the one question a kiosk exists never to leave hanging. So the panel says
              // it, and names every cause it looked for, so the silence reads as *evidence*.
              <>
                <div className={PANEL_HEADER_CLASS}>
                  <h2 className={PANEL_TITLE_CLASS}>Needs attention</h2>
                </div>
                <p data-testid="kiosk-attention-empty" className="text-muted-foreground px-4 py-3 text-xs">
                  Nothing needs attention: {NOTHING_FOUND}.
                </p>
              </>
            ) : (
              // The queue, whole — its own heading and count included, because the count is part of
              // the queue's claim and a second heading over it would be a second thing to keep in
              // step. No `onAttend`: there is nowhere to go from here, and a row that looked like a
              // button and did nothing would be worse than one that never claimed to be one.
              <AttentionQueue
                items={attention}
                // The column is the queue's, so it takes the height (`max-h-none`, `flex-1`) and
                // scrolls inside it. `pt-3` stands its heading on the same line as the tiles
                // panel's, which is the whole reason the two headers are two panels' headers.
                className="max-h-none min-h-0 flex-1 border-b-0 px-3 pt-3 pb-2 max-lg:max-h-64"
              />
            )}
          </aside>
        </div>

        {/*
          The session ticker (#58) — the same panel the shell mounts, minus the click. On a wall it
          earns its place twice over: it is the only thing on the page that proves, at a glance and
          from across the room, that this display is *still receiving* rather than showing a frozen
          picture of ten minutes ago.
        */}
        <SessionActivity event={event} tasks={event.snapshot.tasks} />
      </main>
    </MotionConfig>
  );
}

/**
 * One unfinished orchestration, and the four things a supervisor across the room has to be able
 * to read off it: **who** it is, **whether anything is moving** in it, **how its workers are
 * doing**, and **what is stopping it**.
 *
 * Every one of those is a claim the main screen already makes, made here by the same function
 * (`unfinished.ts`). Nothing on the tile is a control.
 */
function Tile({ tile }: { tile: KioskTile }) {
  const { run, health, silenceMs, workers, gate } = tile;
  const breakdown = statusBreakdown(run.statusCounts);

  return (
    <li>
      <motion.article
        data-testid="kiosk-tile"
        data-run={run.id}
        data-health={health}
        initial={enter({ opacity: 0, y: 6 })}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className={cn(
          'border-panel-border/70 bg-background/40 flex h-full flex-col gap-1.5 rounded-xl border p-3',
          // Silence is the fact the wall is for. It is not an alarm — a silent run is not a dead
          // one and this tool never says it is (CONTEXT.md) — so it is a warmer border and not a
          // red one: enough to find from across the room, not enough to claim a diagnosis.
          health === 'silent' && 'border-run-silent/40 bg-run-silent/5'
        )}
      >
        <header className="flex min-w-0 items-center gap-2">
          {/* The dot is silent here (`announce`): the line below says the health in words, and
              says more than the dot can — how long the silence has lasted. */}
          <HealthDot health={health} className="size-2.5" announce={false} />
          <b className="min-w-0 flex-1 truncate text-sm font-semibold" title={run.label}>
            {run.label}
          </b>
        </header>

        <code
          className="text-muted-foreground/80 block truncate pl-4.5 font-mono text-[11px]"
          title={run.handle ?? undefined}
        >
          {run.handle ?? '— no handle on record —'}
        </code>

        {/*
          The health, in the words the dot says it in — `HEALTH_WORDS`, the one table both screens
          read, so a wall cannot sharpen "silent" into something the evidence does not support
          (CONTEXT.md: never dead, never ended, never stuck). What the tile adds is the *measure*:
          how long the silence has lasted, which is the number that decides whether to walk over.
        */}
        <p data-testid="kiosk-tile-health" className="pl-4.5 text-xs">
          <span className={health === 'silent' ? 'text-run-silent-ink font-medium' : 'text-muted-foreground'}>
            {HEALTH_WORDS[health]}
            {health === 'silent' &&
              (silenceMs === null
                ? ' · no readable activity instant'
                : ` · nothing recorded for ${relativeTime(silenceMs)}`)}
          </span>
        </p>

        {/* The worst worker in the cast (#47), in the rail's own sentence (`runWorkerSummary`). */}
        <p
          data-testid="kiosk-tile-workers"
          data-health={workers?.state ?? 'none'}
          className={cn(
            'pl-4.5 text-xs tabular-nums',
            workers?.state === 'stale' ? cn('font-semibold', STALE_WORKER_INK) : 'text-muted-foreground'
          )}
        >
          {/*
            The rail draws nothing here; a wall says it, because "how are the workers" is a
            question this screen exists to answer and a blank would read as an empty answer.
            `null` is *no current attempt on record* — never "nobody is running", which is a claim
            about a process the database cannot make (CONTEXT.md, ADR 0001). An attempt whose
            instants will not parse says so under its own name (`unknown`, SPEC §5).
          */}
          {workers === null ? 'no current dispatch attempt on record' : workers.parts.join(' · ')}
        </p>

        {gate !== null && (
          <p
            data-testid="kiosk-tile-gate"
            className={cn('mt-auto flex items-start gap-1.5 rounded-lg px-2 py-1 text-xs', GATE_THEME.surface)}
          >
            <OctagonAlert role="img" aria-label="blocked on a decision gate" className="size-3.5 shrink-0 translate-y-px" />
            <span className="min-w-0">
              <b className="font-semibold">
                {/* The age of the *oldest* blocking question — how long this orchestration has
                    been stopped, which is the number that decides whether to walk over to it. An
                    ask instant nobody can read still blocks; it simply cannot say for how long. */}
                {gate.waitedMs === null
                  ? 'blocked — no readable ask instant'
                  : `blocked for ${relativeTime(gate.waitedMs)}`}
              </b>
              <span className="block truncate opacity-90" title={gate.question}>
                {gate.question}
              </span>
            </span>
          </p>
        )}

        <p className="text-muted-foreground/80 pl-4.5 text-[11px]">
          {run.cast.length} {run.cast.length === 1 ? 'agent' : 'agents'} · {run.taskCount}{' '}
          {run.taskCount === 1 ? 'task' : 'tasks'}
          {breakdown && ` · ${breakdown}`}
        </p>
      </motion.article>
    </li>
  );
}

/**
 * Nothing unfinished — and the two ways that happens are *not* the same thing, so they are not the
 * same sentence. An empty database has nothing to say about orchestration at all; a database whose
 * every run has converged is a good day, and a wall that said "no orchestrations" to a supervisor
 * whose twelve runs all finished would be lying to them about their own afternoon.
 */
function Nothing({ runs }: { runs: number }) {
  return (
    <div data-testid="kiosk-empty" className="text-muted-foreground flex flex-1 items-center justify-center p-6">
      <p className="max-w-md text-center text-sm">
        {runs === 0
          ? 'No orchestrations in this database yet. Nothing has been coordinated through Orca here.'
          : `Nothing unfinished: all ${runs} ${runs === 1 ? 'orchestration' : 'orchestrations'} in this database have converged.`}
      </p>
    </div>
  );
}

/** What the wall is leaving out, and why — a count, never a way in. The other screen browses. */
function FinishedNote({ finished }: { finished: number }) {
  return (
    <p
      data-testid="kiosk-finished-note"
      className="text-muted-foreground/80 border-panel-border/70 shrink-0 border-t px-4 py-2 text-[11px]"
    >
      {finished} finished {finished === 1 ? 'orchestration is' : 'orchestrations are'} not shown here.
    </p>
  );
}

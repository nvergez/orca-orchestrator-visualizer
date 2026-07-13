import { ArrowUp, ChevronDown, Download, OctagonAlert, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RadarDot } from '@/components/fx/radar-dot';
import { Spotlight, useSpotlight } from '@/components/fx/spotlight';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import { runHealth, type RunHealth } from '../../shared/run-health.ts';
import type { CoordinatorRun, Enrichment, Run, Task } from '../../shared/types.ts';
import { CHIP_CLASS } from '../chip.ts';
import { COPY_ON_HOVER, CopyButton } from '../copy.tsx';
import { Duration } from '../duration.tsx';
import { EASE, enter, SPRING } from '../motion.ts';
import { useNow } from '../relative-time.ts';
import { PANEL_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import {
  isActiveWorkerHealth,
  type WorkerHealth,
  workerHealthByAgent,
} from '../worker-health.ts';
import { Cast } from './Cast.tsx';
import { provenanceOf } from './provenance.ts';
import { formatRunDate, statusBreakdown } from './summary.ts';

/**
 * **The rail lists orchestrators.**
 *
 * It used to say "Runs (inferred)", and it had to, because a row really *was* a guess: tasks
 * bucketed by terminal handle and then cut wherever six idle hours fell — so one terminal reused
 * across four days silently became several unrelated rows, and nothing on screen ever said why.
 *
 * The guess is gone. A row is one `created_by_terminal_handle` — a Claude Code session that was
 * told to coordinate — and there is nothing inferred about a column. The six-hour rule survives as
 * a **wave**, drawn on the canvas with the gap that opened it written on the border (SPEC §4.3): the
 * time gap is now *shown* instead of *imposed*, and one orchestrator stays one row.
 *
 * Two things the rail is still obliged to say out loud:
 *
 * 1. **Who its agents are.** The cast nests under the open row (`Cast.tsx`) — nested, because an
 *    orchestrator *contains* its agents, and a fourth column would state no relationship at all.
 *    Selecting one dims the canvas to their tasks and fills the conversation with their half of the
 *    dialogue. That single click is what the tool is for.
 * 2. **How each one stands.** The database is never pruned, so yesterday's orchestration sits in
 *    the rail beside today's and renders through the exact same code path. There is no history
 *    mode — there is a list, and each row wears its health: `active | silent | finished`, derived
 *    here from `converged`, `lastActivityAt` and the shared wall clock (SPEC §12.3). It is
 *    evidence, not a diagnosis — a silent run is never called ended, dead or stuck — and it is not
 *    the Orca process, whose own state the shell's pill reports separately (SPEC §12.1).
 *
 * The hover highlight **slides** from row to row rather than fading in under each (SPEC §7.9). It is
 * one element with one `layoutId`, so the browser moves it; and it is the difference between a list
 * that responds to you and a list that merely reacts.
 */

/**
 * Some mobile browsers fire mouseenter on tap, which would strand the sliding `rail-hover`
 * highlight (one layoutId, below) on the last row a thumb touched. Hover is a pointer fact, not a
 * width fact, so it is checked once: no hover hardware, no hover state. `matchMedia` is missing in
 * jsdom, and the fallback is `true` — desktop and every existing test see the rail unchanged.
 */
const CAN_HOVER = globalThis.matchMedia?.('(hover: hover)').matches ?? true;
const EMPTY_HEALTH_BY_AGENT: ReadonlyMap<string, WorkerHealth> = new Map();

/**
 * On a phone the rail is a stacked band that folds to a summary row instead of a fixed-width
 * column. The shell owns *whether* it is folded; the rail owns *what folding means* — a pure
 * height clamp, so the list stays mounted, scroll position survives, and the `layoutId`
 * highlights never replay.
 */
export type RailFold = {
  /** True while the band is collapsed to its summary row. */
  folded: boolean;
  onToggle: () => void;
};

/**
 * The explicit way down into older history (#69). The index arrives a page at a time — the 50
 * most recently active orchestrators first — and this is the reader following the cursor, out
 * loud. There is no silent date cutoff to fall off: history ends where the button stops
 * rendering, which is where the server said it ends.
 */
export type RailPaging = {
  /** True while older pages exist beyond what is loaded. */
  hasOlder: boolean;
  loadOlder: () => void;
};

export type RunRailProps = {
  runs: Run[];
  tasks: Task[];
  coordinatorRuns: CoordinatorRun[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
  /** The agent selected inside the open orchestrator — the canvas dims to it, the dock fills with it. */
  selectedAgent: string | null;
  onSelectAgent: (handle: string | null) => void;
  /** An orchestration that started while the user was reading an older one — announced, never jumped to. */
  newRunId: string | null;
  /** Live Orca context (#61), when the opt-in is on. The cast is the one surface that wears it. */
  enrichment?: Enrichment;
  /** "Load older history" — absent when the caller has no pages to offer (canned shells). */
  older?: RailPaging;
  /**
   * Where "Export archive" points for a run (#74) — and **absent in an archived replay**, which
   * is already an export and has nothing to export from. Undefined renders no link at all rather
   * than a disabled one: a control that cannot be used is furniture, and this one would be lying
   * about a database that is not there.
   */
  exportHref?: (runId: string) => string;
  /** Present only on mobile, where the rail is a foldable band. Desktop passes nothing. */
  fold?: RailFold;
};

export function RunRail({
  runs,
  tasks,
  coordinatorRuns,
  selectedId,
  onSelect,
  selectedAgent,
  onSelectAgent,
  newRunId,
  enrichment,
  older,
  exportHref,
  fold,
}: RunRailProps) {
  // Which row the pointer is on. The *only* reason this is state: the sliding highlight is one
  // element that has to know which row to be on top of, and that is a question no row can answer
  // about itself.
  const [hovered, setHovered] = useState<string | null>(null);

  // One clock for every health dot and every "last seen" badge, so the list ages in step — and
  // it ticks on its own (`WALL_CLOCK_TICK_MS`), because a run must cross `active → silent`
  // while the database is pushing nothing at all (SPEC §12.3).
  const now = useNow(runs);
  const healthByRun = useMemo(
    () =>
      new Map(
        runs.map((run) => {
          const runTasks = tasks.filter((task) => task.runId === run.id);
          return [run.id, workerHealthByAgent(runTasks, now)] as const;
        })
      ),
    [runs, tasks, now]
  );

  // What the summary row has to say while the list is clipped: which run, and — if the canvas is
  // dimmed to one agent — which agent, so the filter stays escapable without unfolding.
  const selectedRun = runs.find((run) => run.id === selectedId) ?? null;
  const selectedAgentMember = selectedRun?.cast.find((member) => member.handle === selectedAgent) ?? null;

  // Where focus goes when the band folds under it. Folding makes `rail-body` inert in the same
  // commit, and a browser blurs any focus inside a subtree that goes inert (the focus-fixup
  // rule) — so a keyboard pivot, the tool's central gesture, would silently drop its focus to
  // <body> and the next Tab would restart from the top of the page. The fold hands focus to the
  // toggle instead: the chrome that undoes it. Only on the expanded→folded flip, never on
  // mount or on a viewport crossing — a page must not open by grabbing focus.
  const toggleRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const folded = fold?.folded ?? null;
  const wasFolded = useRef(folded);

  useEffect(() => {
    const was = wasFolded.current;
    wasFolded.current = folded;
    if (folded !== true || was !== false) return;

    const active = document.activeElement;
    if (active === document.body || (active !== null && bodyRef.current?.contains(active))) {
      toggleRef.current?.focus();
    }
  }, [folded]);

  return (
    <motion.nav
      aria-label="Orchestrators"
      initial={enter({ opacity: 0, x: -12 })}
      animate={{ opacity: 1, x: 0 }}
      transition={SPRING}
      className={cn(
        PANEL_CLASS,
        'flex min-h-0 w-[18rem] shrink-0 flex-col overflow-hidden',
        'max-lg:w-full max-lg:shrink',
        // Folding is pure clamping under the root's own `overflow-hidden`: the list stays mounted,
        // scroll position and selection refs survive, and the layoutId highlights never replay.
        // The `min-h-12` is the floor under the clamp: the band is also a flex child of an
        // over-askable column — an open dock band wants 60dvh of it — and a shrinkable panel with
        // no floor is a panel the column can take to zero. One summary row is the band's whole
        // point while folded, so one summary row is what nothing may take.
        fold && 'max-lg:min-h-12',
        fold && (fold.folded ? 'max-lg:max-h-12' : 'max-lg:max-h-[45dvh]')
      )}
    >
      {/*
        The band's summary row — everything the fold owes you while the list is clipped: which run,
        how it stands, is it blocked, am I filtered. Two *sibling* buttons, because a button inside a
        button is not a thing HTML has (the Cast.tsx rule): the toggle owns the row, the `[A2 ✕]`
        chip stands beside it so agent-dimming stays escapable while the canvas is showing (CANVAS
        report §2). Desktop never passes `fold`, so desktop never renders this.
      */}
      {fold && (
        <div className="flex h-12 shrink-0 items-center gap-2 pr-3">
          <button
            ref={toggleRef}
            type="button"
            data-testid="rail-band-toggle"
            aria-expanded={!fold.folded}
            onClick={fold.onToggle}
            className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-4 text-left"
          >
            {selectedRun ? (
              <HealthDot health={runHealth(selectedRun, now)} />
            ) : (
              <RadarDot live={false} />
            )}
            <b className="truncate text-[13px] font-semibold">{selectedRun?.label ?? 'Orchestrators'}</b>
            {selectedRun?.hasBlockingGates && (
              <OctagonAlert
                role="img"
                aria-label="blocked on a decision gate"
                className="text-gate size-4 shrink-0"
              />
            )}
            {/* The new-run chip's news, re-surfaced as the page's one blue while the chip itself is
                clipped below the fold — per SPEC §7.3 it stays a dot, never a navigation. The dot
                says it in colour; the sr-only twin says it in words (the `live-dot` pattern,
                RunRow below), because while the band is folded the chip that would say it out
                loud is inert behind the clamp, and a fact a screen reader cannot reach was
                never surfaced at all. */}
            {newRunId !== null && (
              <>
                <span aria-hidden className="bg-selection size-1.5 shrink-0 rounded-full" />
                <span className="sr-only">new orchestration started</span>
              </>
            )}
            <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">{runs.length}</span>
            <ChevronDown
              className={cn('text-muted-foreground size-4 shrink-0 transition-transform', !fold.folded && 'rotate-180')}
            />
          </button>

          {selectedAgentMember && (
            <button
              type="button"
              data-testid="rail-agent-chip"
              aria-label={`clear the agent filter ${selectedAgentMember.monogram}`}
              onClick={() => onSelectAgent(null)}
              className={cn(CHIP_CLASS, 'shrink-0 cursor-pointer py-1.5')}
            >
              {selectedAgentMember.monogram} <X className="size-3" />
            </button>
          )}
        </div>
      )}

      {/*
        One wrapper around everything the fold clips, so a collapsed band's rows leave the tab
        order (`inert`) and the accessibility tree (`aria-hidden`) instead of lingering as
        focusable ghosts under the clamp. On desktop `fold` is undefined, neither attribute ever
        applies, and the wrapper reproduces the root's flex geometry exactly.
      */}
      <div
        ref={bodyRef}
        data-testid="rail-body"
        inert={fold?.folded ? true : undefined}
        aria-hidden={fold?.folded ? true : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className={cn(PANEL_HEADER_CLASS, 'flex-row items-center gap-2')}>
          <h2 className={PANEL_TITLE_CLASS}>Orchestrators</h2>
          <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">{runs.length}</span>
        </div>

        {/*
          No auto-jump (SPEC §7.3). An orchestration appearing while you read an old one is *news*,
          not an instruction: the canvas is never yanked out from under you.
        */}
        {newRunId && (
          <motion.button
            type="button"
            initial={enter({ opacity: 0, y: -6 })}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING}
            onClick={() => onSelect(newRunId)}
            className={cn(CHIP_CLASS, 'mx-3 mt-2 cursor-pointer max-lg:py-1.5')}
          >
            <ArrowUp className="size-3" />
            new orchestration started
          </motion.button>
        )}

        <ScrollArea className="min-h-0 flex-1">
          {runs.length === 0 ? (
            // The canvas beside it already says what an empty database means; the rail only has to say
            // that it has nothing to list.
            <p className="text-muted-foreground px-4 py-3 text-xs">No orchestrators yet.</p>
          ) : (
            <ul className="space-y-0.5 p-2" onMouseLeave={() => setHovered(null)}>
              {runs.map((run) => (
                <li key={run.id}>
                  <RunRow
                    run={run}
                    now={now}
                    healthByAgent={healthByRun.get(run.id) ?? EMPTY_HEALTH_BY_AGENT}
                    selected={run.id === selectedId}
                    hovered={hovered === run.id}
                    onHover={() => setHovered(run.id)}
                    onSelect={() => onSelect(run.id)}
                  />

                  {/* The cast, under the one that is open — the hierarchy the database has always had,
                      drawn as a hierarchy for the first time. */}
                  {run.id === selectedId && (
                    <>
                      {/* Above the cast, not below it: the export is an action on *this run*, and a
                          run with nineteen agents would otherwise bury it under nineteen rows of
                          somebody else. */}
                      {exportHref && <ExportRun run={run} href={exportHref(run.id)} />}
                      <Cast
                        run={run}
                        healthByAgent={healthByRun.get(run.id) ?? EMPTY_HEALTH_BY_AGENT}
                        selectedAgent={selectedAgent}
                        onSelectAgent={onSelectAgent}
                        enrichment={enrichment}
                      />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}

          {older?.hasOlder && (
            <button
              type="button"
              data-testid="load-older"
              onClick={older.loadOlder}
              className={cn(CHIP_CLASS, 'mx-3 my-2 cursor-pointer max-lg:py-1.5')}
            >
              Load older history
            </button>
          )}

          <CoordinatorRuns runs={coordinatorRuns} />
        </ScrollArea>
      </div>
    </motion.nav>
  );
}

/**
 * One orchestrator, and everything needed to pick it *without opening it* (SPEC §7.2): what it was
 * trying to do, which terminal it ran in, when, how many agents it spawned, how big it was, and how
 * it went.
 *
 * The handle is on the row now, and not only in the tooltip. It is the orchestrator's **name** — the
 * one identity it has anywhere in this schema — and a rail that lists orchestrators and never shows
 * one has not quite said what it is listing.
 */
function RunRow({
  run,
  now,
  healthByAgent,
  selected,
  hovered,
  onHover,
  onSelect,
}: {
  run: Run;
  /** The rail's shared wall clock — health has to age without a push (SPEC §12.3). */
  now: number;
  healthByAgent: ReadonlyMap<string, WorkerHealth>;
  selected: boolean;
  hovered: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const breakdown = statusBreakdown(run.statusCounts);
  const spotlight = useSpotlight();

  return (
    <button
      type="button"
      data-testid="run-row"
      data-run={run.id}
      aria-current={selected}
      aria-expanded={selected}
      onClick={onSelect}
      onMouseEnter={() => {
        if (CAN_HOVER) onHover();
      }}
      title={run.handle ?? 'No terminal handle — Orca never attributed these tasks to one.'}
      className={cn(
        'group relative w-full cursor-pointer rounded-lg py-2 pr-2.5 pl-3 text-left',
        'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none'
      )}
      {...spotlight}
    >
      {/*
        The highlight that follows the pointer down the list. One element, one `layoutId` — so moving
        from row to row *moves* it, and the list reads as one surface the pointer is travelling
        across rather than twenty surfaces taking turns lighting up.
      */}
      {hovered && !selected && (
        <motion.span
          aria-hidden
          layoutId="rail-hover"
          transition={EASE}
          className="bg-accent/60 absolute inset-0 rounded-lg"
        />
      )}

      {/* The selected orchestrator wears the page's one blue, and a bar in it — the same "this is the
          one you are looking at" the canvas outlines a node with. It is a *separate* element from the
          hover highlight, because a selection is not a hover that stuck. */}
      {selected && (
        <motion.span
          aria-hidden
          layoutId="rail-selected"
          transition={SPRING}
          className="bg-selection-soft/70 border-selection/25 absolute inset-0 rounded-lg border"
        >
          <span className="bg-selection absolute top-1.5 bottom-1.5 left-0 w-[3px] rounded-full" />
        </motion.span>
      )}

      <Spotlight />

      <span className="relative flex items-center gap-2">
        <HealthDot health={runHealth(run, now)} className="size-2" />
        <b className="truncate text-[13px] font-semibold">{run.label}</b>
        <BlockedFlag blocked={run.hasBlockingGates} />
      </span>

      <code className="text-muted-foreground/80 relative mt-0.5 block truncate pl-4 font-mono text-[10.5px]">
        {run.handle ?? '— no handle on record —'}
      </code>

      <span className="text-muted-foreground relative mt-0.5 flex flex-wrap gap-x-1.5 pl-4 text-[11px]">
        <span>{formatRunDate(run.startedAt)}</span>
        {/* How long the run occupied the clock — the run span (#66), open and ageing while the
            run is live. Absent when the retained evidence supported no observation: this row
            shows no number rather than an invented one. */}
        {run.duration && (
          <>
            <Dot />
            <Duration observation={run.duration} testId="run-span" className="tabular-nums" />
          </>
        )}
        <Dot />
        {/* The number this whole screen is now about: how many agents this orchestrator spawned. */}
        <span data-testid="agent-count">
          {run.cast.length} {run.cast.length === 1 ? 'agent' : 'agents'}
        </span>
        <Dot />
        <span>
          {run.taskCount} {run.taskCount === 1 ? 'task' : 'tasks'}
        </span>
        {breakdown && (
          <>
            <Dot />
            <span>{breakdown}</span>
          </>
        )}
        {/* The repository hint (SPEC §14.4): the project every absolute path retained across this
            run's tasks agrees on — question-marked, with the provenance said in place, because it
            is a reading of evidence and not a column. It is a caption on the row the *handle*
            keys; it never groups, sorts or selects anything (the rail's order is activity, its
            identity is the handle, and both are decided before hints exist). */}
        {run.repoHint && (
          <>
            <Dot />
            <span
              data-testid="run-repo-hint"
              title={`Repository hint — uncertain, read ${provenanceOf(run.repoHint)}. Never used to group or identify runs.`}
            >
              {run.repoHint.value}?<span className="opacity-70"> · {provenanceOf(run.repoHint)}</span>
            </span>
          </>
        )}
      </span>

      <RunWorkerHealth run={run} healthByAgent={healthByAgent} />
    </button>
  );
}

function RunWorkerHealth({
  run,
  healthByAgent,
}: {
  run: Run;
  healthByAgent: ReadonlyMap<string, WorkerHealth>;
}) {
  const active = run.cast
    .map((member) => healthByAgent.get(member.handle) ?? { state: 'inactive' as const })
    .filter(isActiveWorkerHealth);
  if (active.length === 0) return null;

  const staleWithoutHeartbeat = active.filter(
    (health) => health.state === 'stale' && health.heartbeat === 'missing'
  ).length;
  const stale = active.filter((health) => health.state === 'stale' && health.heartbeat === 'received').length;
  const quiet = active.filter((health) => health.state === 'quiet').length;
  const working = active.filter((health) => health.state === 'working').length;
  const state = staleWithoutHeartbeat + stale > 0 ? 'stale' : quiet > 0 ? 'quiet' : 'working';
  const parts = [
    staleWithoutHeartbeat > 0 && `${staleWithoutHeartbeat} stale without heartbeat`,
    stale > 0 && `${stale} stale`,
    quiet > 0 && `${quiet} awaiting heartbeat`,
    working > 0 && `${working} active`,
  ].filter((part): part is string => part !== false);

  return (
    <span
      data-testid="run-worker-health"
      data-health={state}
      className={cn(
        'relative mt-1 ml-4 block text-[10px] tabular-nums',
        state === 'stale' ? 'font-bold text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
      )}
    >
      {parts.join(' · ')}
    </span>
  );
}

function Dot() {
  return <span className="opacity-40">·</span>;
}

/**
 * The three looks of run health, in one table so a state cannot pulse one thing, wear another
 * and say a third. Only `active` moves — the page's one "this is not finished" gesture
 * (SPEC §7.9). `silent` holds still in amber over work that has not converged; `finished` holds
 * still in the muted grey of a story that is over. The words are the glossary's (CONTEXT.md),
 * and nobody else's: a silent run is *not* "ended", "dead" or "stuck" — the model reports
 * retained evidence, and those three are diagnoses the database cannot support (SPEC §12.3).
 */
const HEALTH_LOOK: Record<RunHealth, { pulses: boolean; dot: string | false; words: string }> = {
  active: { pulses: true, dot: false, words: 'active — recent activity' },
  silent: { pulses: false, dot: 'bg-run-silent/70', words: 'silent — unfinished, no recent activity' },
  finished: { pulses: false, dot: false, words: 'finished' },
};

/**
 * A run's health, worn as the row's dot — with an sr-only twin saying it in words, because a
 * colour a screen reader cannot reach was never said at all.
 */
function HealthDot({ health, className }: { health: RunHealth; className?: string }) {
  const look = HEALTH_LOOK[health];

  return (
    <>
      <RadarDot
        live={look.pulses}
        className={cn(className, look.dot)}
        // Not `aria-hidden`, unlike the shell's: on the rail this dot *is* the answer to "how
        // does this run stand", and the sr-only twin below is how it reaches everyone.
      />
      <span data-testid="health-dot" data-health={health} className="sr-only">
        {look.words}
      </span>
    </>
  );
}

/**
 * **Export this orchestrator** (#74, ADR 0005) — under the open row, beside its cast, because the
 * thing being exported is *the run you have open* and nothing else.
 *
 * It is a link, not a button, and that is the design rather than an implementation detail:
 *
 * - **It happens once, when a person asks.** A link is the least a click can do — the browser
 *   saves a file and the page does not change. No watcher is started, no recorder, no retention:
 *   the archive is a photograph, taken because somebody pressed the shutter (ADR 0005).
 * - **It is one run.** The affordance only exists on the selected row, so "export exactly one
 *   selected orchestrator run" is a thing the UI *cannot* get wrong.
 * - **The file names itself.** `download` lets the server's `Content-Disposition` — the run and
 *   the instant — decide what lands in the downloads folder, so the page never has to hold a copy
 *   of the artifact to name it.
 *
 * It sits *outside* `RunRow`'s button, not inside it: a link inside a button is not a thing HTML
 * has (the same rule the mobile band's agent chip follows).
 */
function ExportRun({ run, href }: { run: Run; href: string }) {
  return (
    <a
      data-testid="export-run"
      data-run={run.id}
      href={href}
      download
      title={`Save ${run.label}’s retained evidence — its tasks, attempts, gates and conversation — as an offline archive you can replay with orca-viz --archive`}
      className={cn(CHIP_CLASS, 'mx-3 my-1.5 cursor-pointer max-lg:py-1.5')}
    >
      <Download className="size-3" />
      Export archive
    </a>
  );
}

/**
 * The octagon — a decision gate is provably blocking this orchestration right now
 * (`run.hasBlockingGates`, #45). Not merely "a question was never answered": stale probes on
 * finished runs wore this flag for days before the blocking fact was separated from the
 * lifecycle state.
 *
 * The rail's job is to let you pick the orchestrator worth opening *without* opening it (SPEC §7.2),
 * and a blocked one is the most worth opening there is: it is not slow, it is **stopped**, and it
 * will stay stopped until someone goes and answers it. The strip interrupts once you are inside it;
 * this is what tells you which one to be inside.
 */
function BlockedFlag({ blocked }: { blocked: boolean }) {
  if (!blocked) return null;

  return (
    <OctagonAlert
      data-testid="run-gate-marker"
      role="img"
      aria-label="blocked on a decision gate"
      className="text-gate ml-auto size-3.5 shrink-0"
    >
      <title>Blocked on a decision gate</title>
    </OctagonAlert>
  );
}

/**
 * Orca's built-in `Coordinator` loop writes these; agent- and CLI-driven coordination never does, so
 * the table is empty on every real database we have seen (SPEC §4.2, trap 3).
 *
 * It is rendered **if rows exist** and **nothing depends on it** — it is not, and cannot be, the
 * run-scoping key. Which is why this is a footnote under the rail and not the rail.
 */
function CoordinatorRuns({ runs }: { runs: CoordinatorRun[] }) {
  if (runs.length === 0) return null;

  return (
    <section
      data-testid="coordinator-runs"
      className="text-muted-foreground border-panel-border/70 mt-4 border-t px-4 py-3 text-[11px]"
    >
      <h3 className="text-[10px] font-semibold tracking-widest uppercase">Coordinator runs</h3>
      <ul className="mt-1.5 space-y-1">
        {runs.map((run) => (
          <li key={run.id} title={run.coordinatorHandle} className="group/copy flex items-center gap-1.5">
            <code className="font-mono">{shortHandle(run.coordinatorHandle)}</code>
            <span className="opacity-70">· {run.status}</span>
            <CopyButton
              value={run.coordinatorHandle}
              label="coordinator handle"
              className={cn('ml-auto size-5 pointer-coarse:size-8', COPY_ON_HOVER)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

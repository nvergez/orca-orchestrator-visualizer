import { Database, Moon, Sun, Waypoints } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useMemo, useState } from 'react';
import { Beams } from '@/components/fx/beams';
import { RadarDot } from '@/components/fx/radar-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { CastMember, Gate, Meta, Run, StreamEvent, Task, Turn } from '../shared/types.ts';
import { livenessSentence, schemaSentence } from '../shared/wording.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { GATE_THEME } from './canvas/theme.ts';
import { Conversation } from './conversation/Conversation.tsx';
import { useArrivals, usePulses } from './conversation/pulses.ts';
import { GateStrip } from './gates/GateStrip.tsx';
import { fetchTaskDetail, type TaskLoader, useTaskDetail } from './inspector/detail.ts';
import { Inspector } from './inspector/Inspector.tsx';
import { EASE, enter, SPRING } from './motion.ts';
import { RunRail } from './rail/RunRail.tsx';
import { useRunSelection } from './rail/selection.ts';
import { FIELD_BACKDROP_STYLE, FIELD_CLASS, PANEL_CLASS } from './surface.ts';
import { useThemeMode } from './theme-mode.ts';

/**
 * The shell — **an orchestrator, the agents it spawned, and what they said to each other.**
 *
 * That sentence is the whole tool, and it is three panels: the orchestrators on the left with
 * their cast nested under the open one, the DAG in the middle, and the conversation on the right.
 * The database has always held all three and the screen used to name none of them: the rail said
 * "Runs (inferred)" and named a row after its first task's title, so the two characters a reader
 * is actually following — who coordinated, and who did the work — appeared nowhere at all.
 *
 * **The shell owns the two selections, because they are the two that no panel can own.**
 *
 * - **The agent is the pivot** (SPEC §7.2). One click in the rail dims the canvas to that agent's
 *   tasks *and* fills the conversation with their half of the dialogue. Two panels, one movement,
 *   and neither of them can see the other — so the state lives here, which is the only place that
 *   can see both. It is the tool's central gesture.
 * - **The task is the same story.** The node the canvas outlines and the task the inspector
 *   describes are one task; clicking a node opens its story end to end, and clicking it again lets
 *   go, so the way out is where the way in was. A turn in the conversation, a gate, a dep chip —
 *   anything that *names* a task — goes to it, following it across into another orchestration if
 *   that is where it lives, because refusing would leave a real dependency looking like a dead end.
 *
 * **The gate strip is the third thing the shell owns**, and for the same reason: it sits above the
 * canvas, it belongs to the selected *orchestrator*, and clicking it selects a *task* — three
 * pieces of state that live in three different panels and meet nowhere else. It is here, and not in
 * the dock, because a question that has stopped your orchestration has to be in your way; and it is
 * rendered only while there is one, so it stays a signal rather than becoming furniture.
 *
 * **The dock holds one panel, and it swaps** (SPEC §7.1): the conversation by default, the node
 * inspector while a task is selected — never both stacked, because at this node count the canvas
 * deserves the width.
 *
 * There is no history mode. The database is never pruned, so yesterday's orchestration sits in the
 * rail beside today's and renders through the exact same code path; live-ness is a green dot.
 *
 * **And it is a field with panels on it, not a page with rules drawn across it** (SPEC §7.9). The
 * panels float, the field shows through the gaps, and `reducedMotion="user"` is set once, here, so
 * that a reader who has asked their machine for stillness gets a completely still tool without a
 * single component having to remember to check.
 */

/** Stable empty arrays: a fresh `[]` each render would re-run the layout on every tick. */
const NO_RUNS: Run[] = [];
const NO_TASKS: Task[] = [];
const NO_GATES: Gate[] = [];
const NO_TURNS: Turn[] = [];
const NO_CAST: CastMember[] = [];

export type AppProps = {
  event: StreamEvent | null;
  /**
   * How the inspector fetches a task's bodies (#20). It defaults to the real `GET /api/task/:id`
   * and is a *prop* so the shell can be driven against a canned detail — the same reason
   * `StreamEvent` arrives as one: everything the client renders comes in through its props, and
   * the network lives at the edges (`Live.tsx`, `inspector/detail.ts`).
   */
  loadTask?: TaskLoader;
};

export function App({ event, loadTask = fetchTaskDetail }: AppProps) {
  const runs = event?.snapshot.runs ?? NO_RUNS;
  const { selected, select, newRunId } = useRunSelection(runs);

  // Every task in the database, which is a different question from the canvas's. The canvas draws
  // one orchestrator's; a *dependency* is an edge in the schema and knows nothing about which
  // terminal created which task, so resolving one against the canvas's tasks alone would report a
  // task in the next orchestration along as deleted (the inspector's dep chips).
  const allTasks = event?.snapshot.tasks ?? NO_TASKS;

  // The conversation is the server's, whole, on every push (SPEC §4.7) — the client picks a scope
  // and nothing else. What still arrives as a *delta* is the message log, and it is the only thing
  // that can say **what just happened**, which is what flashes a node (`conversation/pulses.ts`).
  const pulses = usePulses(useArrivals(event));

  const turns = event?.snapshot.turns ?? NO_TURNS;

  // The two pieces of state that are nobody's panel and everybody's business.
  //
  // **The agent is the pivot** (SPEC §7.2). One click in the rail dims the canvas to that agent's
  // tasks *and* fills the conversation with their half of the dialogue — two panels, one movement,
  // and neither of them can see the other. So it lives here, which is the only place that can see
  // both. The task is the same story: the node the canvas outlines and the task the inspector
  // describes are one task.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // The scoping, in one line. Every task carries the run the server put it in, so the client never
  // re-derives the grouping — it only picks which one to draw.
  const tasks = useMemo(
    () => (selected ? allTasks.filter((task) => task.runId === selected.id) : NO_TASKS),
    [allTasks, selected]
  );

  // The same scoping, for the gates (#19) — and it is the *only* thing the client does to
  // them. Which question is still open, and which run it blocks, are answers the server has
  // already worked out from the `decision_gate` messages (`server/gates.ts`); re-deriving
  // either here would be re-implementing the one trap the ticket exists to avoid.
  const openGates = useMemo(
    () =>
      event && selected
        ? event.snapshot.gates.filter((gate) => gate.runId === selected.id && gate.status === 'open')
        : NO_GATES,
    [event, selected]
  );

  // Only ever a task on the canvas: a selection is cleared whenever the run changes, and a run
  // whose tasks a reset deleted takes its selection with it.
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  // **Every** gate this task raised, answered ones included (#19 derived them; #20 shows them).
  // The node wears one ⛔ marker because it has room for one; the inspector is where the decision
  // that was actually made is legible.
  const taskGates = useMemo(
    () =>
      event && selectedTask ? event.snapshot.gates.filter((gate) => gate.taskId === selectedTask.id) : NO_GATES,
    [event, selectedTask]
  );

  // The bodies, on the click and not before — the 172 KB the snapshot exists to not send
  // (SPEC §6.3). The fetch is the shell's because the *selection* is: the panel that reads it is
  // mounted and unmounted by this very state.
  const { detail, error: detailError } = useTaskDetail(selectedTask?.id ?? null, event, loadTask);

  /**
   * The rail. A different orchestrator is a different canvas, a different cast and a different
   * conversation — so neither the task nor the **agent** selection survives it. An `A2` in one
   * orchestration is a different terminal from the `A2` in the next, and carrying the selection
   * across would silently dim the new canvas to a stranger.
   */
  function selectRun(runId: string): void {
    select(runId);
    setSelectedAgent(null);
    setSelectedTaskId(null);
  }

  /** A node. Clicking it again is how you let go of it. */
  function selectTask(taskId: string): void {
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
  }

  /**
   * A gate, a dependency chip, a turn in the conversation — anything that *names* a task rather
   * than toggling one. It selects: clicking a blocking question a second time to mean "never mind"
   * would be a strange thing for a blocker to offer, and the way out of a selection is the node,
   * where the way in to it was.
   *
   * And it goes wherever the task **is**. An orchestrator is a bucket of
   * `created_by_terminal_handle`, and `tasks.deps` is a real edge in the schema that knows nothing
   * about which terminal created which task — so an edge can perfectly well cross from one
   * orchestration into another, or into the synthetic `Unattributed` one where 4 of 76 live tasks
   * sit. Refusing to follow it would leave a real dependency looking like a dead end.
   */
  function showTask(taskId: string): void {
    const target = allTasks.find((task) => task.id === taskId);
    if (target && target.runId !== selected?.id) {
      select(target.runId);
      setSelectedAgent(null); // A different orchestrator's cast — see `selectRun`.
    }
    setSelectedTaskId(taskId);
  }

  if (!event) return <Connecting />;

  return (
    // One switch, at the top, for a reader who has asked their machine to hold still. Every
    // transform animation below it stops being a transform; nothing has to opt in.
    <MotionConfig reducedMotion="user">
      <main className={FIELD_CLASS}>
        <Backdrop />

        <TopBar meta={event.meta} />

        <Notices meta={event.meta} />

        <div className="flex min-h-0 flex-1 gap-2">
          <RunRail
            runs={runs}
            coordinatorRuns={event.snapshot.coordinatorRuns}
            selectedId={selected?.id ?? null}
            onSelect={selectRun}
            selectedAgent={selectedAgent}
            onSelectAgent={setSelectedAgent}
            newRunId={newRunId}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {/*
              Above the canvas, and only while something is blocked (#19). It is not a panel in
              the dock and it is not a tab: a question that has stopped your orchestration has to
              be in your way, or it is a question you will not see until you go looking for it —
              and you go looking for it only once you have already noticed nothing is moving.
            */}
            <GateStrip gates={openGates} tasks={tasks} onSelectTask={showTask} />

            <div className="min-h-0 flex-1">
              <Canvas
                tasks={tasks}
                cast={selected?.cast}
                waves={selected?.waves}
                selectedAgent={selectedAgent}
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={selectTask}
                pulses={pulses}
              />
            </div>
          </div>

          {/*
            One panel, and it swaps (SPEC §7.1). A selected task is the whole of the condition: the
            inspector is what a selection *is* on screen, and letting the task go is what brings the
            conversation back.

            Deliberately **no exit animation**: the panel that is leaving has nothing left to say,
            and a dock that stayed empty for 200 ms on every click would put a stutter between a
            node and its own story. The one that arrives animates; the one that goes, goes.
          */}
          {selectedTask ? (
            <Inspector
              task={selectedTask}
              gates={taskGates}
              // Every task, not the canvas's: a dep chip that could not see across into another
              // orchestration would call a task sitting right there in the database deleted.
              tasks={allTasks}
              detail={detail}
              error={detailError}
              turns={turns}
              cast={selected?.cast ?? NO_CAST}
              onClose={() => setSelectedTaskId(null)}
              onSelectTask={showTask}
            />
          ) : (
            <Conversation
              turns={turns}
              run={selected}
              selectedAgent={selectedAgent}
              onClearAgent={() => setSelectedAgent(null)}
              onSelectTask={showTask}
            />
          )}
        </div>
      </main>
    </MotionConfig>
  );
}

/**
 * The field the panels stand on: a fine grid, and a soft glow above the work (SPEC §7.9).
 *
 * It is the cheapest thing in the whole redesign and it does the most — a grid says *surface with
 * coordinates* before a single node has drawn, which is exactly what this tool is looking at.
 */
function Backdrop() {
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
function TopBar({ meta }: { meta: Meta }) {
  return (
    <motion.header
      initial={enter({ opacity: 0, y: -8 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(PANEL_CLASS, 'flex h-13 shrink-0 items-center gap-3 px-4')}
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
        <b className="text-sm font-semibold tracking-tight whitespace-nowrap">orca-viz</b>
      </span>

      <Separator orientation="vertical" className="!h-5" />

      <Status meta={meta} />

      <Source meta={meta} />

      <ThemeToggle />
    </motion.header>
  );
}

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
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium',
        live
          ? 'bg-status-completed-soft text-status-completed-ink border-status-completed/50'
          : 'text-muted-foreground bg-muted border-transparent'
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

/** Always on screen, always true: the file, and the schema it turned out to be. */
function Source({ meta }: { meta: Meta }) {
  return (
    <dl className="text-muted-foreground ml-auto flex min-w-0 items-center gap-3 text-[11px]">
      {/* Long, and always worth having: the whole of it is in the tooltip, because "which
          database am I reading" is the one question this bar exists to answer. */}
      <div className="flex min-w-0 items-center gap-1.5" title={meta.dbPath}>
        <dt className="sr-only">Database</dt>
        <Database aria-hidden className="size-3.5 shrink-0 opacity-70" />
        <dd className="m-0 max-w-[26rem] min-w-0">
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
    </dl>
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
      className="text-muted-foreground hover:text-foreground size-7 shrink-0 cursor-pointer"
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
function Notices({ meta }: { meta: Meta }) {
  const schema = schemaSentence(meta);
  if (schema === null && !meta.resetDetected) return null;

  return (
    <motion.div
      initial={enter({ opacity: 0, y: -6 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        'flex shrink-0 flex-col gap-px overflow-hidden rounded-xl border text-xs shadow-lift-1',
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
function Connecting() {
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

import { ChevronUp, Database, Moon, Sun, Table2, Waypoints } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { Beams } from '@/components/fx/beams';
import { RadarDot } from '@/components/fx/radar-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { CastMember, Gate, Meta, StreamEvent, Task, Turn } from '../shared/types.ts';
import { livenessSentence, schemaSentence } from '../shared/wording.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { GATE_THEME, themeOf } from './canvas/theme.ts';
import { Conversation } from './conversation/Conversation.tsx';
import { useArrivals, usePulses } from './conversation/pulses.ts';
import { exchangeCount, selectTurns } from './conversation/select.ts';
import { GateStrip } from './gates/GateStrip.tsx';
import { fetchHistory, type HistoryLoaders, useHistory } from './history.ts';
import { fetchTaskDetail, type TaskLoader, useTaskDetail } from './inspector/detail.ts';
import { Inspector } from './inspector/Inspector.tsx';
import { EASE, enter, SPRING } from './motion.ts';
import { RunRail } from './rail/RunRail.tsx';
import { fetchReport, type ReportLoader } from './report/query.ts';
import { Report } from './report/Report.tsx';
import { FIELD_BACKDROP_STYLE, FIELD_CLASS, PANEL_CLASS, PANEL_TITLE_CLASS } from './surface.ts';
import { useThemeMode } from './theme-mode.ts';
import { useIsMobile } from './viewport.tsx';

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
 * **Below `lg` the row folds into a column** (`docs/design/mobile.md`): the same three panels,
 * stacked — the rail a collapsible band on top, the canvas keeping the middle, the dock a
 * collapsible band at the bottom. Nothing is a new screen and no panel is mounted differently;
 * the page still never scrolls, bands push the canvas rather than cover it, and the shell owns
 * the two folds the way it owns the two selections, for the same reason — a node tap has to open
 * the dock band and an agent tap has to fold the rail, and no panel can see that far.
 *
 * **And it is a field with panels on it, not a page with rules drawn across it** (SPEC §7.9). The
 * panels float, the field shows through the gaps, and `reducedMotion="user"` is set once, here, so
 * that a reader who has asked their machine for stillness gets a completely still tool without a
 * single component having to remember to check.
 */

/** Stable empty arrays: a fresh `[]` each render would re-run the layout on every tick. */
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
  /**
   * How the shell fetches history (#69): the run index a page at a time, and the selected run
   * whole. Defaults to the real GETs; a canned pair drives the whole shell from a test —
   * `loadTask`'s pattern, grown to the two reads the stream stopped carrying.
   */
  loadHistory?: HistoryLoaders;
  /**
   * How the cross-history report is read (#70): `GET /api/report`, one page at a time, sorted and
   * filtered on the server. A prop for the same reason the other two are.
   */
  loadReport?: ReportLoader;
};

export function App({
  event,
  loadTask = fetchTaskDetail,
  loadHistory = fetchHistory,
  loadReport = fetchReport,
}: AppProps) {
  // The stream is the doorbell, this is the door: pages of summaries for the rail, and the
  // selected run's complete evidence, each refetched when `event.affected` names it (#69).
  const { ready, runs, coordinatorRuns, hasOlder, loadOlder, selected, select, newRunId, snapshot } = useHistory(
    event,
    loadHistory
  );

  // The selected run's complete evidence — tasks, gates and turns already scoped to it by the
  // server, which owns the derivation (SPEC §4.3). Beside the run's own tasks ride the far ends
  // of dependency edges that cross into other orchestrations (`linkedTasks`): an edge is real
  // whichever terminal created its endpoints, and a dep chip that could not see across would
  // call a task sitting right there in the database deleted.
  const tasks = snapshot?.tasks ?? NO_TASKS;
  const allTasks = useMemo(() => (snapshot === null ? NO_TASKS : [...snapshot.tasks, ...snapshot.linkedTasks]), [snapshot]);

  // The conversation is the server's, whole, per selected run (SPEC §4.7) — the client picks a
  // scope and nothing else. What still arrives as a *delta* is the message log, and it is the
  // only thing that can say **what just happened**, which is what flashes a node
  // (`conversation/pulses.ts`).
  const pulses = usePulses(useArrivals(event));

  const turns = snapshot?.turns ?? NO_TURNS;

  // The freshest description of the selected run: its snapshot once loaded, the index summary
  // until then. Both are the same wire shape, and the snapshot is the completer truth (ADR 0002).
  const activeRun = snapshot?.run ?? selected;

  // The two pieces of state that are nobody's panel and everybody's business.
  //
  // **The agent is the pivot** (SPEC §7.2). One click in the rail dims the canvas to that agent's
  // tasks *and* fills the conversation with their half of the dialogue — two panels, one movement,
  // and neither of them can see the other. So it lives here, which is the only place that can see
  // both. The task is the same story: the node the canvas outlines and the task the inspector
  // describes are one task.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // The report is the shell's third selection-shaped thing (#70): it reads *across* runs, and a
  // row it opens moves the run selection, the task selection and the dock — three pieces of state
  // no panel can see. It is a dialog over the whole tool rather than a fourth panel: it is a place
  // you go to find one task and then leave, not a thing you read beside the canvas.
  const [reportOpen, setReportOpen] = useState(false);

  // The fold (SPEC §7.1, below `lg`). Whether each band is expanded is shell state for the same
  // reason the selections are: a node tap has to open the dock band and an agent tap has to fold
  // the rail, and no panel can see that far. All of it exists on desktop, where nothing reads it —
  // every write below is `isMobile`-guarded, so the signed-off layout never churns.
  const isMobile = useIsMobile();
  const [railOpen, setRailOpen] = useState(false);
  const [dockOpen, setDockOpen] = useState(false);
  // The run label the reader was standing in when `showTask` last hopped orchestrations. The
  // inspector narrates it, because on the folded shell the rail's moving `aria-current` is behind
  // a collapsed band, and a silent hop reads as the canvas replacing itself for no reason.
  const [crossRunFrom, setCrossRunFrom] = useState<string | null>(null);
  // Bumped when the dock band collapses after the run changed while it was open — the one
  // re-frame the canvas cannot detect for itself (`Refit`, `canvas/Canvas.tsx`).
  const [refitSignal, setRefitSignal] = useState(0);
  // Which run the dock band was opened on, so `toggleDock` can tell a plain collapse from one
  // that is about to reveal a canvas whose fit ran behind 60dvh of band.
  const dockRun = useRef<string | null>(null);

  // What the collapsed dock handle says while the conversation is docked: the same run-scoped
  // count the panel's own header shows — heartbeats excluded (`exchangeCount`) — computed only on
  // mobile so desktop does no extra work per push. It mirrors Conversation's default `'run'`
  // scope; the panel's internal "All" toggle is a view choice the handle deliberately does not track.
  const dockCount = useMemo(
    () =>
      isMobile ? exchangeCount(selectTurns(turns, { runId: selected?.id ?? null, agentHandle: selectedAgent })) : 0,
    [isMobile, turns, selected, selectedAgent]
  );

  // The gates arrive already scoped to the selected run (#19, #69) — which question is still
  // open is an answer the server worked out from the `decision_gate` messages
  // (`server/gates.ts`); re-deriving it here would re-implement the one trap #19 exists to
  // avoid. The strip wants only the open ones.
  const openGates = useMemo(
    () => (snapshot === null ? NO_GATES : snapshot.gates.filter((gate) => gate.status === 'open')),
    [snapshot]
  );

  // Only ever a task on the canvas: a selection is cleared whenever the run changes, and a run
  // whose tasks a reset deleted takes its selection with it.
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

  // **Every** gate this task raised, answered ones included (#19 derived them; #20 shows them).
  // The node wears one ⛔ marker because it has room for one; the inspector is where the decision
  // that was actually made is legible.
  const taskGates = useMemo(
    () => (snapshot !== null && selectedTask ? snapshot.gates.filter((gate) => gate.taskId === selectedTask.id) : NO_GATES),
    [snapshot, selectedTask]
  );

  // The bodies, on the click and not before — the 172 KB the snapshot exists to not send
  // (SPEC §6.3). The fetch is the shell's because the *selection* is: the panel that reads it is
  // mounted and unmounted by this very state.
  const { detail, error: detailError } = useTaskDetail(selectedTask?.id ?? null, event, loadTask);

  /**
   * The dock band's verbs, carrying the re-fit bookkeeping (`Refit`, `canvas/Canvas.tsx`):
   * `dockRun` remembers which run the band opened on, and a collapse after the run changed
   * underneath it — the cross-run `showTask` case, where the new run's initial fit ran against
   * the strip the band had left — bumps `refitSignal` so dismissal lands on a freshly framed
   * graph. Every other collapse re-frames nothing: the viewport the reader panned is theirs.
   */
  function openDock(): void {
    if (!isMobile) return;
    if (!dockOpen) dockRun.current = selected?.id ?? null;
    setDockOpen(true);
  }

  function toggleDock(): void {
    if (!isMobile) return;
    if (dockOpen && selected?.id !== dockRun.current) setRefitSignal((count) => count + 1);
    if (!dockOpen) dockRun.current = selected?.id ?? null;
    setDockOpen((open) => !open);
  }

  /**
   * The rail. A different orchestrator is a different canvas, a different cast and a different
   * conversation — so neither the task nor the **agent** selection survives it. An `A2` in one
   * orchestration is a different terminal from the `A2` in the next, and carrying the selection
   * across would silently dim the new canvas to a stranger.
   *
   * On the fold the rail band stays open: the cast just unfolded under the tapped row, and the
   * cast is where the central gesture lives. Only the hop narration is stale now.
   */
  function selectRun(runId: string): void {
    select(runId);
    setSelectedAgent(null);
    setSelectedTaskId(null);
    if (isMobile) setCrossRunFrom(null);
  }

  /**
   * The pivot, wrapped: `setSelectedAgent` is still the whole of it, plus one folded-shell
   * reflex — the tap's meaning is "show me the dimmed canvas and the dialogue", both of which
   * are behind the expanded rail, so the rail folds. Instantly, because exits are instant
   * (SPEC §7.9); the way back in is the band header the fold leaves standing.
   */
  function selectAgent(handle: string | null): void {
    setSelectedAgent(handle);
    if (isMobile) setRailOpen(false);
  }

  /**
   * A node. Clicking it again is how you let go of it.
   *
   * Selecting — never letting go — is what opens the dock band: the inspector is what a
   * selection *is* on screen (SPEC §7.1), and on the fold it would otherwise arrive behind a
   * collapsed handle. A same-run selection was never a hop, so the narration clears.
   */
  function selectTask(taskId: string): void {
    const selecting = selectedTaskId !== taskId;
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
    if (!isMobile) return;
    if (selecting) openDock();
    setCrossRunFrom(null);
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
      // Recorded *before* `select` replaces it: the label the collapsed rail was naming is where
      // the reader gets to have come from (`Inspector`'s `hoppedFrom` — mobile-only narration).
      if (isMobile) setCrossRunFrom(selected?.label ?? null);
      select(target.runId);
      setSelectedAgent(null); // A different orchestrator's cast — see `selectRun`.
    } else if (isMobile) {
      setCrossRunFrom(null);
    }
    openDock();
    setSelectedTaskId(taskId);
  }

  /**
   * A row of the cross-history report (#70). It is `showTask` for a task the client has not
   * loaded and cannot look up: the report ranks *all* of retained history, and the row names a
   * run the selected-run snapshot has never seen.
   *
   * So the run id comes from the row, and the two selections are set together: `select` fetches
   * that run whole (`useHistory`), and the task id waits — the inspector opens the moment the
   * snapshot carrying its task lands. The report's whole job is to be an entry point into the
   * existing story, and this is the entrance.
   */
  function openReportRow(runId: string, taskId: string): void {
    if (runId !== selected?.id) {
      if (isMobile) setCrossRunFrom(selected?.label ?? null);
      select(runId);
      setSelectedAgent(null); // A different orchestrator's cast — see `selectRun`.
    }
    openDock();
    setSelectedTaskId(taskId);
    setReportOpen(false);
  }

  // Two things have to land before the shell is worth drawing: the stream's first event (the
  // meta bar is its), and the first index page (the rail is its). Both are one blink locally.
  if (!event || !ready) return <Connecting />;

  return (
    // One switch, at the top, for a reader who has asked their machine to hold still. Every
    // transform animation below it stops being a transform; nothing has to opt in.
    <MotionConfig reducedMotion="user">
      <main className={FIELD_CLASS}>
        <Backdrop />

        <TopBar meta={event.meta} onOpenReport={() => setReportOpen(true)} />

        <Notices meta={event.meta} />

        {/* Across every orchestrator, and over all of them (#70). It is not a panel in the row
            below: those three are one run's story, and this is the search that finds the run. */}
        {reportOpen && (
          <Report
            event={event}
            runs={runs}
            load={loadReport}
            onSelectRow={openReportRow}
            onClose={() => setReportOpen(false)}
          />
        )}

        {/* `max-lg:flex-col` is the fold itself: DOM order rail → centre → dock becomes
            top → middle → bottom, and nothing else about the row changes. */}
        <div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col">
          <RunRail
            runs={runs}
            coordinatorRuns={coordinatorRuns}
            selectedId={selected?.id ?? null}
            onSelect={selectRun}
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            newRunId={newRunId}
            older={{ hasOlder, loadOlder }}
            fold={isMobile ? { folded: !railOpen, onToggle: () => setRailOpen((open) => !open) } : undefined}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {/*
              Above the canvas, and only while something is blocked (#19). It is not a panel in
              the dock and it is not a tab: a question that has stopped your orchestration has to
              be in your way, or it is a question you will not see until you go looking for it —
              and you go looking for it only once you have already noticed nothing is moving.
            */}
            <GateStrip gates={openGates} tasks={tasks} onSelectTask={showTask} />

            {/* `max-lg:min-h-24` floors the canvas: an expanded band + gate + notices can never
                crush React Flow to 0×0, so the fit math never sees a zero container. */}
            <div className="min-h-0 flex-1 max-lg:min-h-24">
              {selected !== null && snapshot === null ? (
                // The selected run's evidence is on its way (#69). Milliseconds on loopback —
                // but an empty canvas would read as "this run has no tasks", which is a claim,
                // and not one anybody has verified yet.
                <LoadingRun />
              ) : (
                <Canvas
                  tasks={tasks}
                  cast={activeRun?.cast}
                  waves={activeRun?.waves}
                  selectedAgent={selectedAgent}
                  selectedTaskId={selectedTask?.id ?? null}
                  onSelectTask={selectTask}
                  pulses={pulses}
                  refitSignal={refitSignal}
                />
              )}
            </div>
          </div>

          {/*
            One panel, and it swaps (SPEC §7.1). A selected task is the whole of the condition: the
            inspector is what a selection *is* on screen, and letting the task go is what brings the
            conversation back.

            Deliberately **no exit animation**: the panel that is leaving has nothing left to say,
            and a dock that stayed empty for 200 ms on every click would put a stutter between a
            node and its own story. The one that arrives animates; the one that goes, goes.

            The wrapper is the dock *band* of the folded shell, and on desktop it is not there at
            all: `lg:contents` erases both wrappers from layout, so the flex row sees the same dock
            child it sees today. Below `lg` the band owns its own height — a handle's worth when
            collapsed, `min(60dvh, 32rem)` of the column when open — so the two dock panels still
            cannot disagree about their dimensions (`surface.ts`).
          */}
          <div
            className={cn(
              'lg:contents',
              'max-lg:flex max-lg:min-h-0 max-lg:flex-col max-lg:gap-2',
              // Collapsed, the band *is* its handle and nothing may compress it. Open, its
              // 60dvh is an ask, not a demand (`shrink`, floored at two handles' worth): the
              // column also owes the rail its summary row, the gate strip its question and the
              // canvas its 96px, and a band that would not shrink was taking those out of the
              // rail — the one sibling with no floor of its own to stand on.
              dockOpen
                ? 'max-lg:h-[min(60dvh,32rem)] max-lg:min-h-24 max-lg:shrink'
                : 'max-lg:h-12 max-lg:shrink-0'
            )}
          >
            {isMobile && <DockHandle task={selectedTask} count={dockCount} open={dockOpen} onToggle={toggleDock} />}

            <div
              data-testid="dock-band-body"
              // A collapsed band's clipped panel leaves the tab order (`inert`) and the
              // accessibility tree (`aria-hidden`) instead of lingering as focusable ghosts
              // under the clamp. React 19 takes the boolean directly.
              inert={isMobile && !dockOpen ? true : undefined}
              aria-hidden={isMobile && !dockOpen ? true : undefined}
              className="lg:contents max-lg:flex max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col"
            >
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
                  cast={activeRun?.cast ?? NO_CAST}
                  onClose={() => {
                    setSelectedTaskId(null);
                    // The dock band stays open — the conversation returns in the same band at the
                    // same height. Only the hop narration has nothing left to narrate.
                    if (isMobile) setCrossRunFrom(null);
                  }}
                  onSelectTask={showTask}
                  // The read wears the same guard as every write: the narration belongs to the
                  // folded shell, and a hop made on a phone must not still be narrating after
                  // the window widens into the desktop dock (mobile.md §4.11, §8 rule 3).
                  hoppedFrom={isMobile ? crossRunFrom : null}
                />
              ) : (
                <Conversation
                  turns={turns}
                  run={activeRun}
                  selectedAgent={selectedAgent}
                  onClearAgent={() => setSelectedAgent(null)}
                  onSelectTask={showTask}
                />
              )}
            </div>
          </div>
        </div>
      </main>
    </MotionConfig>
  );
}

/**
 * The collapsed dock band's whole voice — and a small floating panel of its own, because the
 * collapsed band *is* a panel standing on the field (SPEC §7.9). It names what expanding would
 * show: the selected task's title behind its status dot, or the conversation and how much of it
 * there is. The ticking exchange count is the unread signal, for free — heartbeats are already
 * excluded (`exchangeCount`, `conversation/select.ts`) — and it ticks whether the band is open
 * or not, which is the point of a handle that keeps talking while the panel is folded away.
 *
 * "Conversation" is a `<span>`, not an `<h2>`: the panel behind the fold already carries that
 * heading, and a second one with the same name would collide with it in role queries.
 *
 * Rendered only on `useIsMobile()` — never merely class-hidden — so the 119 desktop tests never
 * see it and the desktop-guard test means something (`docs/design/mobile.md` §1).
 */
function DockHandle({
  task,
  count,
  open,
  onToggle,
}: {
  /** The selected task, or null while the dock holds the conversation. */
  task: Task | null;
  /** Run-scoped exchange count (heartbeats excluded). */
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="dock-band-toggle"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(PANEL_CLASS, 'flex h-12 w-full shrink-0 cursor-pointer items-center gap-2 px-4 text-left')}
    >
      {task ? (
        <>
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', themeOf(task.status).dot)} />
          <b className="min-w-0 truncate text-[13px] font-semibold">{task.title}</b>
        </>
      ) : (
        <>
          <span className={PANEL_TITLE_CLASS}>Conversation</span>
          <span className="text-muted-foreground/70 text-[11px] tabular-nums">
            {count} {count === 1 ? 'exchange' : 'exchanges'}
          </span>
        </>
      )}
      <ChevronUp
        className={cn('text-muted-foreground ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')}
      />
    </button>
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
function TopBar({ meta, onOpenReport }: { meta: Meta; onOpenReport: () => void }) {
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

      <Source meta={meta} />

      {/* The one thing on this bar that is *about all of history* rather than about the run on
          screen — which is why it is here, on the bar the whole tool shares, and not in the rail
          that lists one orchestrator at a time (#70). */}
      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="open-report"
        onClick={onOpenReport}
        className="h-7 shrink-0 cursor-pointer gap-1.5 px-2 text-[11px] pointer-coarse:h-10"
      >
        <Table2 className="size-3.5" />
        <span className="max-lg:hidden">Task report</span>
      </Button>

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
        // `max-lg:shrink` lets the pill compress and the sentence *wrap* — never truncate: the
        // wording is the spec's, and the words are content, not decoration.
        'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium max-lg:min-w-0 max-lg:shrink',
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
 * Between selecting a run and its complete evidence arriving (#69) — one blink on loopback.
 * It stands where the canvas will, because that is what it is standing in for; and it says
 * "loading" rather than showing an empty canvas, because an empty canvas *means something*
 * ("no tasks in this run") and nothing has verified that yet.
 */
function LoadingRun() {
  return (
    <section aria-label="Loading run" className={cn(PANEL_CLASS, 'flex h-full items-center justify-center')}>
      <p data-testid="run-loading" className="text-muted-foreground text-xs">
        Loading this run’s history…
      </p>
    </section>
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

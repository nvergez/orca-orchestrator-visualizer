import { Archive, ChevronUp, Database, Moon, Sun, Table2, Waypoints } from 'lucide-react';
import { motion, MotionConfig } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { RadarDot } from '@/components/fx/radar-dot';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import type { CastMember, Gate, Meta, StreamEvent, Task, Turn } from '../shared/types.ts';
import {
  archiveCompatibilitySentence,
  archivedSentence,
  HISTORY_LOSS_SENTENCES,
  livenessSentence,
  schemaSentence,
} from '../shared/wording.ts';
import type { ArchiveRead } from './archive.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { GATE_THEME, themeOf } from './canvas/theme.ts';
import { type Connection, CONNECTION_WORDING } from './connection.ts';
import { Conversation } from './conversation/Conversation.tsx';
import { useArrivals, usePulses } from './conversation/pulses.ts';
import { exchangeCount, selectTurns } from './conversation/select.ts';
import { GateStrip } from './gates/GateStrip.tsx';
import { fetchHistory, type HistoryLoaders, useHistory } from './history.ts';
import { fetchTaskDetail, type TaskLoader, useTaskDetail } from './inspector/detail.ts';
import { Inspector } from './inspector/Inspector.tsx';
import { EASE, enter, SPRING } from './motion.ts';
import { localInstant, relativeTime, useClock } from './relative-time.ts';
import { RunRail } from './rail/RunRail.tsx';
import { fetchReport, type ReportLoader } from './report/query.ts';
import { Report } from './report/Report.tsx';
import { Scoreboard } from './scoreboard/Scoreboard.tsx';
import { Splash } from './Splash.tsx';
import { FIELD_BACKDROP_STYLE, FIELD_CLASS, PANEL_CLASS, PANEL_TITLE_CLASS } from './surface.ts';
import { useThemeMode } from './theme-mode.ts';
import { CentreToggle, type CentreView } from './timeline/CentreToggle.tsx';
import { Timeline } from './timeline/Timeline.tsx';
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
 * rail beside today's and renders through the exact same code path; each row wears its
 * `active | silent | finished` health, and the Orca process has its own pill (SPEC §12).
 *
 * **And there is one archived mode, which is this same shell with a file behind it** (#74,
 * `Replay.tsx`). An `archive` prop swaps the two things that would otherwise be lies — the
 * liveness bar becomes an *archived* one, and the export link has nothing to export — and changes
 * nothing else: the rail, the canvas, the gate strip, the conversation and the inspector are the
 * same components reading the same evidence, because a post-mortem you saved is still a
 * post-mortem (ADR 0005).
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
   * What the transport is doing right now (#57) — the `EventSource`'s story, told by `Live.tsx`
   * and only *worn* here. It defaults to `connected` because a canned event in a test is a
   * delivered one; the state a real error produces always arrives explicitly.
   */
  connection?: Connection;
  /**
   * When the snapshot in `event` was applied, in epoch ms of this machine's clock (#57) —
   * null when no apply has been observed, and then the top bar claims no age at all rather
   * than inventing one.
   */
  appliedAt?: number | null;
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
  /**
   * **The archived replay** (#74, `Replay.tsx`): the saved run this shell is showing, instead of
   * a database it is connected to. Null — the default — is the live tool.
   *
   * It is a *presentation* difference and deliberately nothing more: the rail, the canvas, the
   * gates, the conversation and the inspector are the same components reading the same evidence
   * (ADR 0005 — "archived replay uses the ordinary selected-run presentation wherever possible").
   * What changes is exactly what would otherwise be a lie — the liveness bar becomes an *archived*
   * one, there is no stream to pulse a node, and there is nothing to export from an export.
   */
  archive?: ArchiveRead | null;
};

export function App({
  event,
  loadTask = fetchTaskDetail,
  connection = 'connected',
  appliedAt = null,
  loadHistory = fetchHistory,
  loadReport = fetchReport,
  archive = null,
}: AppProps) {
  // The stream is the doorbell, this is the door: pages of summaries for the rail, and the
  // selected run's complete evidence, each refetched when `event.affected` names it (#69). An
  // archived replay has no doorbell at all — the file is read once, on mount, and nothing polls.
  const { ready, runs, coordinatorRuns, hasOlder, loadOlder, selected, select, newRunId, snapshot } = useHistory(
    event,
    loadHistory,
    archive === null ? 'live' : 'offline'
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
  // until then. Both are the same wire shape, and the snapshot is the completer truth (ADR 0004).
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

  // **The centre's view, and it is not a fourth selection** (#72). The DAG is the default and the
  // timeline is a lens on the *same* selected run — so this state sits deliberately apart from the
  // selections above and no handler below ever writes it. That separation is the acceptance
  // criterion: pressing the toggle must not move the run, the agent or the task, and the surest
  // way to guarantee that is to leave it nothing to move them with.
  //
  // It survives a change of run, because it is a *preference* about how this reader reads. Dropping
  // it on every rail click would be the tool overruling a choice the reader had just made.
  const [centre, setCentre] = useState<CentreView>('dag');

  // The dock's third panel (#68): the scoreboard, over the conversation's slot. A view choice,
  // not a selection — it survives a run change (it simply shows the new run's cast) and it
  // waits out a task selection (the inspector wins the dock while a node is open).
  const [scoreboardOpen, setScoreboardOpen] = useState(false);

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

  // The gates arrive already scoped to the selected run (#19, #69), and this filter is the
  // *only* thing the client does to them. Which question is blocking *now* is an answer the
  // server has already worked out from the gate messages, the `decision_gates` rows and the
  // tasks' current state (`server/gates.ts`, #45); re-deriving it here would re-implement the
  // one trap #19 exists to avoid.
  //
  // The strip interrupts over `blocking` alone — never over a lifecycle state. `status` records
  // what was written down; `blocking` is whether work is provably paused *right now* (#45), and
  // an unanswered historical ask is not enough evidence to put a question in someone's way
  // (SPEC §7.1). Stale probes on finished runs wore the old `status === 'open'` flag for days.
  const blockingGates = useMemo(
    () => (snapshot === null ? NO_GATES : snapshot.gates.filter((gate) => gate.blocking)),
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
  // A replay has no stream — its bar is the archive's — so it waits only for the file, and it
  // waits under archived wording: "connecting to the database" is a claim, even for one frame.
  if ((event === null && archive === null) || !ready) return <Splash archived={archive !== null} />;

  return (
    // One switch, at the top, for a reader who has asked their machine to hold still. Every
    // transform animation below it stops being a transform; nothing has to opt in.
    <MotionConfig reducedMotion="user">
      <main className={FIELD_CLASS}>
        <Backdrop />

        {/* The bar, and the notices under it: the archive's when there is one, the live database's
            when there is not. The nested ternary is the type narrowing — the guard above has
            already ruled out "neither", and an assertion here would be a claim the compiler cannot
            check on a shell that has two sources of truth. */}
        {archive !== null ? (
          <ArchiveBar view={archive} />
        ) : event !== null ? (
          <TopBar
            meta={event.meta}
            connection={connection}
            appliedAt={appliedAt}
            onOpenReport={() => setReportOpen(true)}
          />
        ) : null}

        {archive !== null ? (
          <ArchiveNotices view={archive} />
        ) : event !== null ? (
          <Notices meta={event.meta} />
        ) : null}

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
            // The tasks the client actually holds — the selected run's, and the far ends of its
            // cross-run dep edges (#69 took every *other* run's tasks off the wire). The rail
            // derives per-agent worker health from them, which it can therefore only do for the
            // run that is open; the others show their summary counts and no health line, which
            // is the honest shape of what a paged history knows.
            tasks={allTasks}
            coordinatorRuns={coordinatorRuns}
            selectedId={selected?.id ?? null}
            onSelect={selectRun}
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            newRunId={newRunId}
            // Live Orca context (#61) — absent unless the server was started with the opt-in.
            // It lands on the cast rows and nowhere else: the canvas never sees it, which is
            // half of how an enrichment push can never remount the DAG.
            enrichment={event?.enrichment}
            older={{ hasOlder, loadOlder }}
            // **The export** (#74): one link, on the run the reader has open, and nowhere else —
            // an archive is of *one selected run*, and the affordance says so by only ever
            // existing on one. A replay is already an export: there is nothing here to export
            // from it, so the rail is handed nothing and renders no link at all.
            exportHref={archive === null ? archiveHref : undefined}
            fold={isMobile ? { folded: !railOpen, onToggle: () => setRailOpen((open) => !open) } : undefined}
          />

          <div className="flex min-w-0 flex-1 flex-col gap-2">
            {/*
              Above the canvas, and only while something is blocked (#19). It is not a panel in
              the dock and it is not a tab: a question that has stopped your orchestration has to
              be in your way, or it is a question you will not see until you go looking for it —
              and you go looking for it only once you have already noticed nothing is moving.
            */}
            <GateStrip gates={blockingGates} tasks={tasks} onSelectTask={showTask} />

            {/*
              The centre's two views (#72). The toggle sits above the thing it toggles, on the side
              the eye leaves the canvas on — and it changes what is *drawn*, never what is
              *selected*: `setCentre` is the whole of its reach.
            */}
            <div className="flex shrink-0 justify-end">
              <CentreToggle view={centre} onChange={setCentre} />
            </div>

            {/* `max-lg:min-h-24` floors the canvas: an expanded band + gate + notices can never
                crush React Flow to 0×0, so the fit math never sees a zero container. */}
            <div className="min-h-0 flex-1 max-lg:min-h-24">
              {selected !== null && snapshot === null ? (
                // The selected run's evidence is on its way (#69). Milliseconds on loopback —
                // but an empty canvas would read as "this run has no tasks", which is a claim,
                // and not one anybody has verified yet.
                <LoadingRun />
              ) : centre === 'timeline' ? (
                // Every attempt, on the clock. It reads the selected-run snapshot and nothing else:
                // ADR 0004 made that snapshot complete, which is *why* every retained attempt can be
                // its own bar (SPEC §14.4). No second endpoint, and no second copy of the evidence.
                //
                // **The tab decides the view, and nothing else may.** Falling back to the canvas when
                // there is no run to draw would leave the timeline tab lit above a DAG — the toggle
                // claiming a view the centre is not showing, which is the one thing a toggle must
                // never do. With no run selected there is nothing for *either* view to draw, so this
                // one says so in its own voice.
                snapshot === null ? (
                  <NoRun />
                ) : (
                  <Timeline
                    snapshot={snapshot}
                    selectedAgent={selectedAgent}
                    selectedTaskId={selectedTask?.id ?? null}
                    // A bar is a node: clicking it again lets go. A marker or an untimed row *names*
                    // a task, and naming is never a toggle — the same distinction the gate strip and
                    // the conversation already draw (`selectTask` vs `showTask`).
                    onSelectTask={selectTask}
                    onShowTask={showTask}
                  />
                )
              ) : (
                <Canvas
                  // Continuity belongs to one orchestrator's stream updates. Picking another one
                  // is an explicit navigation to a different graph, whose initial fit is useful
                  // and whose viewport must not inherit the last run's framing (mobile.md §6).
                  // It keys off the *selection*, not the loaded snapshot: the run's evidence
                  // arriving is a stream update to the graph you already chose, and remounting on
                  // it would throw away the viewport every time the run refetched (#46).
                  key={selected?.id ?? 'empty'}
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
            {isMobile && (
              <DockHandle
                task={selectedTask}
                scoreboard={scoreboardOpen}
                count={dockCount}
                open={dockOpen}
                onToggle={toggleDock}
              />
            )}

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
                  // An archive holds one run, so a dependency that leaves it cannot be opened:
                  // the chip names the task and says where it went, rather than offering a click
                  // that would land on a run this file does not contain (`Inspector`'s `Deps`).
                  archived={archive !== null}
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
              ) : scoreboardOpen ? (
                <Scoreboard run={selected} onClose={() => setScoreboardOpen(false)} />
              ) : (
                <Conversation
                  turns={turns}
                  run={activeRun}
                  selectedAgent={selectedAgent}
                  onClearAgent={() => setSelectedAgent(null)}
                  onSelectTask={showTask}
                  onOpenScoreboard={() => setScoreboardOpen(true)}
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
 * Where the export lives — `GET /api/run/:id/archive` (#74). It is a plain link with `download`
 * on it, and that is the whole mechanism: the browser saves the file, the server names it, and
 * nothing in this page holds a copy of an artifact it just handed to the user.
 */
function archiveHref(runId: string): string {
  return `/api/run/${encodeURIComponent(runId)}/archive`;
}

/**
 * **The bar an archived replay wears instead of the liveness one** (#74) — and the one thing on
 * this screen that absolutely may not be mistaken for the live tool.
 *
 * So it says the opposite of what the live bar says, in the same place, out of the same sentence
 * factory (`archivedSentence`, `shared/wording.ts`, printed at boot too): *archived — an offline
 * export taken on <date>; nothing is running, and nothing here will change.* There is no radar
 * dot, because a radar dot on this page would mean a process is alive; there is no database path,
 * because there is no database and the artifact deliberately never carried one; and there is no
 * "last write", because nothing is writing.
 *
 * What it *does* show is the run it holds and the tool that exported it — the provenance a person
 * needs in order to trust a file somebody sent them.
 */
function ArchiveBar({ view }: { view: ArchiveRead }) {
  const { provenance, run } = view.archive;

  return (
    <motion.header
      initial={enter({ opacity: 0, y: -8 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        PANEL_CLASS,
        'flex h-13 shrink-0 items-center gap-3 px-4',
        'max-lg:h-auto max-lg:min-h-13 max-lg:py-2 max-lg:landscape:min-h-11 max-lg:landscape:py-1'
      )}
    >
      <span className="flex shrink-0 items-center gap-2">
        <span className="bg-muted text-muted-foreground flex size-6 items-center justify-center rounded-md">
          <Archive className="size-3.5" />
        </span>
        <b className="text-sm font-semibold tracking-tight whitespace-nowrap max-lg:hidden">orca-viz</b>
      </span>

      <Separator orientation="vertical" className="!h-5 max-lg:hidden" />

      {/*
        `role="status"` and `data-state="archived"` where the live bar puts its liveness pill —
        the same slot, the opposite claim. Muted, and with no dot at all: every animated ring in
        this tool means "this is not finished" (SPEC §7.9), and everything here is.
      */}
      <p
        role="status"
        data-state="archived"
        className="text-muted-foreground bg-muted flex shrink-0 items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 text-[11px] font-medium max-lg:min-w-0 max-lg:shrink"
      >
        <span className="first-letter:uppercase">{archivedSentence(provenance, localInstant)}.</span>
      </p>

      <dl className="text-muted-foreground ml-auto flex min-w-0 items-center gap-3 text-[11px]">
        {/* The run in the file — the only thing this page is about, and the answer to "what am I
            looking at" that `dbPath` gives on the live bar. */}
        <div className="flex min-w-0 items-center gap-1.5" title={run.handle ?? undefined}>
          <dt className="sr-only">Archived run</dt>
          <dd className="m-0 max-w-[26rem] min-w-0 max-lg:max-w-[30vw]">
            <span className="block truncate font-semibold">{run.label}</span>
          </dd>
        </div>

        <div className="flex shrink-0 items-center gap-1.5" title="The Orca schema this evidence was read through">
          <dt className="sr-only">Source schema</dt>
          <dd className="m-0">
            <Badge variant="outline" className="px-1.5 py-0 font-mono text-[10px]">
              v{provenance.source.schemaVersion}
            </Badge>
          </dd>
        </div>

        <div className="hidden shrink-0 items-center gap-1.5 lg:flex" title="The build that exported this archive">
          <dt className="opacity-70">Exported by</dt>
          <dd className="m-0 font-mono">{provenance.tool}</dd>
        </div>
      </dl>

      <ThemeToggle />
    </motion.header>
  );
}

/**
 * What is *wrong*, in a replay — the same slot as the live notices, and two different files to be
 * wrong about.
 *
 * **The archive** may be one a newer orca-viz wrote. It is readable and read, and the reader says
 * so out loud rather than showing a post-mortem that is quietly missing an unknown amount of what
 * was exported (`archiveCompatibilitySentence`, #74's last acceptance criterion).
 *
 * **The database it came from** may have been one *this build* could not fully read — a newer Orca,
 * or an older one missing a column. That was true at export time, months ago, on a machine this
 * replay has never seen; the archive is the only thing that still remembers it (`source`). So the
 * schema banner is the same banner the live tool shows, out of the same sentence (`schemaSentence`,
 * `shared/wording.ts`) — because it is the same fact about the same kind of database, and an
 * absence with no explanation would otherwise read as a bug in the replay.
 */
function ArchiveNotices({ view: { archive, compatibility } }: { view: ArchiveRead }) {
  const incompatible = archiveCompatibilitySentence(compatibility, archive.provenance);
  const { source } = archive.provenance;
  const schema = schemaSentence(source);

  if (incompatible === null && schema === null) return null;

  return (
    <motion.div
      initial={enter({ opacity: 0, y: -6 })}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className={cn(
        'flex shrink-0 flex-col gap-px overflow-hidden rounded-xl border text-xs shadow-lift-1',
        'max-lg:max-h-24 max-lg:overflow-y-auto max-lg:landscape:max-h-16',
        GATE_THEME.surface
      )}
    >
      {incompatible !== null && (
        <p role="status" data-state="archive-newer" className="px-4 py-2">
          {incompatible}
        </p>
      )}

      {schema !== null && (
        <section role="status" data-state="archive-schema" className="px-4 py-2">
          <p>
            <span className="opacity-70">At export: </span>
            {schema} <span className="opacity-70">(source schema v{source.schemaVersion})</span>
          </p>

          {source.degraded.length > 0 && (
            <ul className="mt-1 list-disc pl-5 opacity-90">
              {source.degraded.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          )}
        </section>
      )}
    </motion.div>
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
  scoreboard,
  count,
  open,
  onToggle,
}: {
  /** The selected task, or null while the dock holds the conversation or the scoreboard. */
  task: Task | null;
  /** True while the dock's conversation slot holds the scoreboard instead (#68). */
  scoreboard: boolean;
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
      ) : scoreboard ? (
        <span className={PANEL_TITLE_CLASS}>Scoreboard</span>
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
function TopBar({
  meta,
  connection,
  appliedAt,
  onOpenReport,
}: {
  meta: Meta;
  connection: Connection;
  appliedAt: number | null;
  onOpenReport: () => void;
}) {
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
/**
 * The top bar's pill — one shape for the two status pills standing beside each other, so they
 * cannot drift apart (the doctrine of `chip.ts`: one class string, in one place). And one quiet
 * state shared between them, because "nothing is wrong, nothing is news" should look the same
 * whichever fact is saying it.
 */
const PILL_CLASS = 'flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium';
const PILL_QUIET_CLASS = 'text-muted-foreground bg-muted border-transparent';

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
      <span className="first-letter:uppercase">{livenessSentence(meta, localInstant)}.</span>
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
        <dd className="m-0 tabular-nums">{localInstant(meta.dbMtime)}</dd>
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
function Notices({ meta }: { meta: Meta }) {
  const schema = schemaSentence(meta);
  if (schema === null && meta.historyLoss.length === 0) return null;

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

      {/*
       * One notice per lost history surface, in the stable order `meta.historyLoss` carries
       * (SPEC §5.1). The sentence is the spec's, down to the word (`wording.ts`), and it is
       * rendered verbatim — backticks included, exactly as the degraded list above renders
       * its entries — so the page and the terminal cannot drift into different claims about
       * what the evidence proves.
       */}
      {meta.historyLoss.map((surface) => (
        <p key={surface} role="status" data-state={surface} className="px-4 py-2">
          {HISTORY_LOSS_SENTENCES[surface]}
        </p>
      ))}
    </motion.div>
  );
}

/**
 * The timeline, with no run to draw. The rail is empty — a fresh database, or one an
 * `orchestration reset` emptied — so there is no selected run and no evidence to lay against a
 * clock. It stands where the timeline would, because the tab above it says *timeline*, and a tab
 * that lit a view the centre was not showing would be the toggle telling a small lie.
 */
function NoRun() {
  return (
    <section aria-label="No run selected" className={cn(PANEL_CLASS, 'flex h-full items-center justify-center')}>
      <p data-testid="timeline-no-run" className="text-muted-foreground text-xs">
        Select an orchestrator to see its dispatch timeline.
      </p>
    </section>
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


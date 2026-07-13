import { ChevronUp } from 'lucide-react';
import { MotionConfig } from 'motion/react';
import { useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import type { CastMember, Gate, Run, StreamEvent, Task, Turn } from '../shared/types.ts';
import { SessionActivity } from './activity/SessionActivity.tsx';
import { type AttentionItem, deriveAttention } from './attention.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { themeOf } from './canvas/theme.ts';
import type { Connection } from './connection.ts';
import { Conversation } from './conversation/Conversation.tsx';
import { useArrivals, usePulses } from './conversation/pulses.ts';
import { exchangeCount, selectTurns } from './conversation/select.ts';
import { GateStrip } from './gates/GateStrip.tsx';
import { fetchTaskDetail, type TaskLoader, useTaskDetail } from './inspector/detail.ts';
import { Inspector } from './inspector/Inspector.tsx';
import { RunRail } from './rail/RunRail.tsx';
import { useRunSelection } from './rail/selection.ts';
import { useNow } from './relative-time.ts';
import { Backdrop, Connecting, Notices, TopBar } from './shell/chrome.tsx';
import { FIELD_CLASS, PANEL_CLASS, PANEL_TITLE_CLASS } from './surface.ts';
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
const NO_RUNS: Run[] = [];
const NO_TASKS: Task[] = [];
const NO_GATES: Gate[] = [];
const NO_TURNS: Turn[] = [];
const NO_CAST: CastMember[] = [];
const NO_ATTENTION: AttentionItem[] = [];

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
};

export function App({ event, loadTask = fetchTaskDetail, connection = 'connected', appliedAt = null }: AppProps) {
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

  // The attention queue (#56): one pure derivation over the latest snapshot and the shared wall
  // clock — the same clock the rail's health dots age on, so an item that exists because
  // something is ten minutes quiet and a dot that is amber for the same reason cannot disagree.
  // The clock ticking (`WALL_CLOCK_TICK_MS`) is also what lets a fresh failure age *out* of the
  // queue while a quiet database pushes nothing at all.
  const attentionNow = useNow(event);
  const attention = useMemo(
    () => (event ? deriveAttention(event.snapshot, attentionNow) : NO_ATTENTION),
    [event, attentionNow]
  );

  // The two pieces of state that are nobody's panel and everybody's business.
  //
  // **The agent is the pivot** (SPEC §7.2). One click in the rail dims the canvas to that agent's
  // tasks *and* fills the conversation with their half of the dialogue — two panels, one movement,
  // and neither of them can see the other. So it lives here, which is the only place that can see
  // both. The task is the same story: the node the canvas outlines and the task the inspector
  // describes are one task.
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

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

  // The scoping, in one line. Every task carries the run the server put it in, so the client never
  // re-derives the grouping — it only picks which one to draw.
  const tasks = useMemo(
    () => (selected ? allTasks.filter((task) => task.runId === selected.id) : NO_TASKS),
    [allTasks, selected]
  );

  // The same scoping, for the gates (#19) — and it is the *only* thing the client does to
  // them. Which question is blocking *now*, and which run it blocks, are answers the server
  // has already worked out from the gate messages, the `decision_gates` rows and the tasks'
  // current state (`server/gates.ts`, #45); re-deriving either here would be re-implementing
  // the one trap the ticket exists to avoid. The strip interrupts over `blocking` alone —
  // an unanswered historical ask is not enough evidence to interrupt (SPEC §7.1).
  const blockingGates = useMemo(
    () =>
      event && selected
        ? event.snapshot.gates.filter((gate) => gate.runId === selected.id && gate.blocking)
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
   * An attention item is a place to go, through the seam that already exists (#56): the task
   * when the cause names one — `showTask`, because a cause can perfectly well live in an
   * orchestration you are not looking at — otherwise the run it blocks. Nothing is written
   * anywhere: attending to a cause is *going and looking at it*, and the item leaves the queue
   * only when its evidence does (SPEC §1.2).
   *
   * The task is resolved before it is shown, and the run is the fallback when it does not
   * resolve. On the wire that cannot happen — every id an attention item carries was read off a
   * task in this very snapshot, and the server nulls a `Gate.taskId` naming a task a reset
   * deleted (`server/attribution.ts`) — but `showTask` on an id it cannot find selects nothing
   * at all, and a queue whose whole promise is "one click and you are there" is the last place
   * that may quietly do nothing.
   */
  function attend(item: AttentionItem): void {
    const target = item.taskId === null ? undefined : allTasks.find((task) => task.id === item.taskId);

    if (target) showTask(target.id);
    else if (item.runId !== null) selectRun(item.runId);
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

  if (!event) return <Connecting />;

  return (
    // One switch, at the top, for a reader who has asked their machine to hold still. Every
    // transform animation below it stops being a transform; nothing has to opt in.
    <MotionConfig reducedMotion="user">
      <main className={FIELD_CLASS}>
        <Backdrop />

        <TopBar meta={event.meta} connection={connection} appliedAt={appliedAt} />

        <Notices meta={event.meta} />

        {/* `max-lg:flex-col` is the fold itself: DOM order rail → centre → dock becomes
            top → middle → bottom, and nothing else about the row changes. */}
        <div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col">
          <RunRail
            runs={runs}
            tasks={allTasks}
            coordinatorRuns={event.snapshot.coordinatorRuns}
            attention={attention}
            onAttend={attend}
            selectedId={selected?.id ?? null}
            onSelect={selectRun}
            selectedAgent={selectedAgent}
            onSelectAgent={selectAgent}
            newRunId={newRunId}
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

            {/* `max-lg:min-h-24` floors the canvas: an expanded band + gate + notices can never
                crush React Flow to 0×0, so the fit math never sees a zero container. */}
            <div className="min-h-0 flex-1 max-lg:min-h-24">
              <Canvas
                tasks={tasks}
                cast={selected?.cast}
                waves={selected?.waves}
                selectedAgent={selectedAgent}
                selectedTaskId={selectedTask?.id ?? null}
                onSelectTask={selectTask}
                pulses={pulses}
                refitSignal={refitSignal}
              />
            </div>

            {/*
              The session ticker (#58), under the canvas the activity happened on. Global, like
              the diff it renders — a transition in an unselected orchestration is still activity,
              and clicking its entry hops there (`showTask`). Always mounted, because its whole
              memory lives inside it and an unmount would be the reload the ticket says clears it;
              it draws nothing until this session has actually observed something.
            */}
            <SessionActivity event={event} tasks={allTasks} onSelectTask={showTask} />
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
                  cast={selected?.cast ?? NO_CAST}
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
                  run={selected}
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

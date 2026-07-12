import { useMemo, useState } from 'react';
import type { FeedMessage, Gate, Meta, Run, StreamEvent, Task } from '../shared/types.ts';
import { livenessSentence, schemaSentence } from '../shared/wording.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { STATUS_COLORS } from './canvas/theme.ts';
import { useFeed, usePulses } from './feed/feed.ts';
import { Feed } from './feed/Feed.tsx';
import { GateStrip } from './gates/GateStrip.tsx';
import { fetchTaskDetail, type TaskLoader, useTaskDetail } from './inspector/detail.ts';
import { Inspector } from './inspector/Inspector.tsx';
import { RunRail } from './rail/RunRail.tsx';
import { useRunSelection } from './rail/selection.ts';

/**
 * The shell — the run rail on the left, the canvas in the middle, the feed on the right, and
 * above all of them the truth about what is being read.
 *
 * The rail is what makes the canvas mean anything (#16). Before it, every task in the
 * database rendered as one graph: 76 nodes, 13 unrelated orchestrations, four days of
 * history in a single unreadable soup. Now the canvas renders **exactly one run**, and
 * because the database is never pruned, yesterday's run renders through that same code
 * path as today's — there is no history mode, there is a list, and one of them happens to
 * be live.
 *
 * **The link between the feed and the canvas is owned here** (#18), because it is the one
 * thing neither of them can own: a feed row knows a task id, and a node knows it was clicked,
 * and only the shell knows which run is on screen. So the shell holds the selected task, and
 * both directions of the link are one state change:
 *
 * - **A feed row → its node.** The canvas highlights and centres it. If the message belongs to
 *   another run, the rail follows: the row *is* the user asking to go there, and leaving them
 *   staring at a canvas that does not contain the task they just clicked would be the worse
 *   surprise. (The rule this does not break is the *automatic* one — a run starting on its own
 *   never moves the canvas; it gets a chip, and the chip is the rail's, from #16.)
 * - **A node → its story.** The dock swaps to the inspector, which is that task's story end to
 *   end — its spec, its result, every attempt, its messages, its gates, its neighbours (#20).
 *   Clicking the same node again lets it go, so the way out is where the way in was.
 *
 * **The gate strip is the third thing the shell owns** (#19), and for the same reason: it sits
 * above the canvas, it belongs to the selected *run*, and clicking it selects a *task* — three
 * pieces of state that live in three different panels and meet nowhere else. It is here, and
 * not in the dock, because a question that has stopped your orchestration has to be in your
 * way; and it is rendered only while that run has an open gate, so it stays a signal.
 *
 * **The dock holds one panel, and it swaps** (#20, SPEC §7.1): the feed by default, the node
 * inspector while a task is selected — never both stacked, because at this node count the canvas
 * deserves the width. Which is why the selection lives here and not in either of them: it is the
 * thing that decides *which panel exists*.
 */

/** Stable empty arrays: a fresh `[]` each render would re-run the layout on every tick. */
const NO_RUNS: Run[] = [];
const NO_TASKS: Task[] = [];
const NO_GATES: Gate[] = [];

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
  // one run; a *dependency* is an edge in the schema and knows nothing about a run this tool
  // inferred, so resolving one against the canvas's tasks alone would report a task in the next
  // run along as deleted (#20's dep chips).
  const allTasks = event?.snapshot.tasks ?? NO_TASKS;

  // The feed remembers; `event.messages` is only ever the delta after the client's cursor.
  const { messages, arrived } = useFeed(event);
  const pulses = usePulses(arrived);

  // The one piece of panel state that is *not* a panel's: the task the canvas outlines and the
  // task the feed is filtered to are the same task, and neither panel can see the other.
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  // The scoping, in one line. Every task carries the run the server inferred for it, so the
  // client never re-derives the grouping — it only picks which one to draw.
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
      event && selectedTask
        ? event.snapshot.gates.filter((gate) => gate.taskId === selectedTask.id)
        : NO_GATES,
    [event, selectedTask]
  );

  // The bodies, on the click and not before — the 172 KB the snapshot exists to not send
  // (SPEC §6.3). The fetch is the shell's because the *selection* is: the panel that reads it is
  // mounted and unmounted by this very state.
  const { detail, error: detailError } = useTaskDetail(selectedTask?.id ?? null, event, loadTask);

  /** The rail. A different run is a different canvas, so the task selection does not survive it. */
  function selectRun(runId: string): void {
    select(runId);
    setSelectedTaskId(null);
  }

  /** A feed row. The task it names is the destination — its run is merely how to get there. */
  function selectMessage(message: FeedMessage): void {
    if (message.taskId === null) return; // An unlinked row is not a link (SPEC §4.2, trap 8).
    if (message.runId !== null && message.runId !== selected?.id) select(message.runId);
    setSelectedTaskId(message.taskId);
  }

  /** A node. Clicking it again is how you let go of it. */
  function selectTask(taskId: string): void {
    setSelectedTaskId((current) => (current === taskId ? null : taskId));
  }

  /**
   * A gate, a dependency chip — anything that names a task rather than toggling one. It
   * *selects*: clicking the question a second time meaning "never mind" would be a strange thing
   * for a blocker to offer, and the way out of a selection is the node, where the way in to it was.
   *
   * And it goes wherever the task **is**. Runs are *inferred* (`runs.ts`): they are buckets of
   * `created_by_terminal_handle`, split on a six-hour idle gap, with the null-handle tasks in a
   * synthetic run of their own — so an edge in `tasks.deps` can perfectly well cross from one of
   * them into another. Refusing to follow it would leave a real dependency looking like a dead
   * end. It is the rule a feed row already follows: naming a task *is* asking to go to it.
   */
  function showTask(taskId: string): void {
    const target = allTasks.find((task) => task.id === taskId);
    if (target && target.runId !== selected?.id) select(target.runId);
    setSelectedTaskId(taskId);
  }

  if (!event) {
    return (
      <main>
        <h1>orca-viz</h1>
        <p>Connecting to the database…</p>
      </main>
    );
  }

  return (
    <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', margin: 0 }}>
      <header style={{ padding: '8px 16px', borderBottom: '1px solid #e4e4e7', flexShrink: 0 }}>
        <h1 style={{ fontSize: 16, margin: '0 0 4px' }}>orca-viz</h1>
        <Status meta={event.meta} />
        <Notices meta={event.meta} />
        <Source meta={event.meta} />
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <RunRail
          runs={runs}
          coordinatorRuns={event.snapshot.coordinatorRuns}
          selectedId={selected?.id ?? null}
          onSelect={selectRun}
          newRunId={newRunId}
        />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/*
            Above the canvas, and only while something is blocked (#19). It is not a panel in
            the dock and it is not a tab: a question that has stopped your orchestration has to
            be in your way, or it is a question you will not see until you go looking for it —
            and you go looking for it only once you have already noticed nothing is moving.
          */}
          <GateStrip gates={openGates} tasks={tasks} onSelectTask={showTask} />

          <div style={{ flex: 1, minHeight: 0 }}>
            <Canvas
              tasks={tasks}
              selectedTaskId={selectedTask?.id ?? null}
              onSelectTask={selectTask}
              pulses={pulses}
            />
          </div>
        </div>

        {/*
          One panel, and it swaps (SPEC §7.1). A selected task is the whole of the condition:
          the inspector is what a selection *is* on screen, and letting the task go is what
          brings the feed back.
        */}
        {selectedTask ? (
          <Inspector
            task={selectedTask}
            gates={taskGates}
            // Every task, not the canvas's: a dep chip that could not see across an inferred run
            // would call a task that is sitting right there in the database deleted.
            tasks={allTasks}
            detail={detail}
            error={detailError}
            onClose={() => setSelectedTaskId(null)}
            onSelectTask={showTask}
          />
        ) : (
          <Feed messages={messages} runId={selected?.id ?? null} onSelectMessage={selectMessage} />
        )}
      </div>
    </main>
  );
}

/**
 * Live, or last-known — the one thing that is always worth saying, said in the words the
 * spec pins down (SPEC §6.1). `src/shared/wording.ts` owns the sentence, so this and the
 * line the terminal prints at boot are the same sentence and cannot drift apart.
 */
function Status({ meta }: { meta: Meta }) {
  return (
    <p role="status" data-state={meta.liveness}>
      {livenessSentence(meta, formatTime)}.
    </p>
  );
}

/**
 * The things that are *wrong*, in the order they change what you should believe about the
 * screen. Nothing renders when there is nothing to say: a banner that is always there is
 * furniture, and furniture stops being read.
 */
function Notices({ meta }: { meta: Meta }) {
  const schema = schemaSentence(meta);

  return (
    <>
      {/*
       * The schema banner (#21) — one banner for both directions of drift, because they are
       * the same fact told from two sides: this database is not the one the build was written
       * for. A newer Orca gets the warning and nothing else; an older one gets the list of
       * what a missing column cost, so a badge that never renders is *explained* rather than
       * looking like a bug. That is the whole point of `meta.degraded` reaching the screen.
       */}
      {schema !== null && (
        <section role="status" data-state={`schema-${meta.schemaSupport}`} style={NOTICE_STYLE}>
          <p style={{ margin: 0 }}>
            {schema} <span style={{ opacity: 0.75 }}>(schema v{meta.schemaVersion})</span>
          </p>

          {meta.degraded.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {meta.degraded.map((feature) => (
                <li key={feature}>{feature}</li>
              ))}
            </ul>
          )}
        </section>
      )}

      {meta.resetDetected && (
        <p role="status" data-state="reset" style={NOTICE_STYLE}>
          Some history is gone: an <code>orchestration reset</code> wiped messages this database once held.
        </p>
      )}
    </>
  );
}

/** Always on screen, always true: the file, and the schema it turned out to be. */
function Source({ meta }: { meta: Meta }) {
  return (
    <dl>
      <dt>Database</dt>
      <dd>
        <code>{meta.dbPath}</code>
      </dd>

      <dt>Schema</dt>
      <dd>v{meta.schemaVersion}</dd>

      <dt>Last write</dt>
      <dd>{formatTime(meta.dbMtime)}</dd>
    </dl>
  );
}

/** An instant a person can place, in their own timezone. */
function formatTime(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

/**
 * The page's one colour for "read this before you believe the screen" — the amber a
 * `dispatched` node already wears, *taken* from `canvas/theme.ts` rather than typed out again.
 * Those colours were signed off on screen and retuning them is re-approval, not refactoring
 * (theme.ts) — a second copy of the hex here is a copy that drifts out of that quietly.
 */
const NOTICE_STYLE = {
  margin: '4px 0',
  padding: '6px 10px',
  border: `1px solid ${STATUS_COLORS.dispatched.border}`,
  borderRadius: 4,
  background: STATUS_COLORS.dispatched.bg,
  color: STATUS_COLORS.dispatched.text,
  fontSize: 12,
};

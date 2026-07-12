import { useMemo, useState } from 'react';
import type { FeedMessage, Meta, Run, StreamEvent, Task } from '../shared/types.ts';
import { livenessSentence, schemaSentence } from '../shared/wording.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { STATUS_COLORS } from './canvas/theme.ts';
import { useFeed, usePulses } from './feed/feed.ts';
import { Feed, type FeedScope } from './feed/Feed.tsx';
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
 * - **A node → its story.** The feed filters to that task's messages, end to end. Clicking the
 *   same node again clears the filter, so the way out is where the way in was.
 *
 * The gate strip (#19) and the node inspector (#20) are still to come; the dock the inspector
 * will swap into is this one, and until it does, the feed is what it shows.
 */

/** Stable empty arrays: a fresh `[]` each render would re-run the layout on every tick. */
const NO_RUNS: Run[] = [];
const NO_TASKS: Task[] = [];

export function App({ event }: { event: StreamEvent | null }) {
  const runs = event?.snapshot.runs ?? NO_RUNS;
  const { selected, select, newRunId } = useRunSelection(runs);

  // The feed remembers; `event.messages` is only ever the delta after the client's cursor.
  const { messages, arrived } = useFeed(event);
  const pulses = usePulses(arrived);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [scope, setScope] = useState<FeedScope>('run');
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  // The scoping, in one line. Every task carries the run the server inferred for it, so the
  // client never re-derives the grouping — it only picks which one to draw.
  const tasks = useMemo(
    () => (event && selected ? event.snapshot.tasks.filter((task) => task.runId === selected.id) : NO_TASKS),
    [event, selected]
  );

  // Only ever a task on the canvas: a selection is cleared whenever the run changes, and a run
  // whose tasks a reset deleted takes its selection with it.
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) ?? null;

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

        <div style={{ flex: 1, minWidth: 0 }}>
          <Canvas
            tasks={tasks}
            selectedTaskId={selectedTask?.id ?? null}
            onSelectTask={selectTask}
            pulses={pulses}
          />
        </div>

        <Feed
          messages={messages}
          runId={selected?.id ?? null}
          scope={scope}
          onScope={setScope}
          showHeartbeats={showHeartbeats}
          onShowHeartbeats={setShowHeartbeats}
          selectedTask={selectedTask}
          onClearTask={() => setSelectedTaskId(null)}
          onSelectMessage={selectMessage}
        />
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

import { type CSSProperties, useMemo } from 'react';
import type { Meta, Run, StreamEvent, Task } from '../shared/types.ts';
import { livenessSentence, schemaSentence } from '../shared/wording.ts';
import { Canvas } from './canvas/Canvas.tsx';
import { RunRail } from './rail/RunRail.tsx';
import { useRunSelection } from './rail/selection.ts';

/**
 * The shell — the run rail on the left, the canvas in the middle, and above both of them the
 * truth about what is being read.
 *
 * The rail is what makes the canvas mean anything (#16). Before it, every task in the
 * database rendered as one graph: 76 nodes, 13 unrelated orchestrations, four days of
 * history in a single unreadable soup. Now the canvas renders **exactly one run**, and
 * because the database is never pruned, yesterday's run renders through that same code
 * path as today's — there is no history mode, there is a list, and one of them happens to
 * be live.
 *
 * The gate strip, feed and inspector arrive with their own tickets (#18–#20).
 */

/** Stable empty arrays: a fresh `[]` each render would re-run the layout on every tick. */
const NO_RUNS: Run[] = [];
const NO_TASKS: Task[] = [];

export function App({ event }: { event: StreamEvent | null }) {
  const runs = event?.snapshot.runs ?? NO_RUNS;
  const { selected, select, newRunId } = useRunSelection(runs);

  // The scoping, in one line. Every task carries the run the server inferred for it, so the
  // client never re-derives the grouping — it only picks which one to draw.
  const tasks = useMemo(
    () => (event && selected ? event.snapshot.tasks.filter((task) => task.runId === selected.id) : NO_TASKS),
    [event, selected]
  );

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
          onSelect={select}
          newRunId={newRunId}
        />

        <div style={{ flex: 1, minWidth: 0 }}>
          <Canvas tasks={tasks} />
        </div>
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
        <section role="status" data-state={`schema-${meta.schemaSupport}`} style={BANNER}>
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
        <p role="status" data-state="reset" style={BANNER}>
          Some history is gone: an <code>orchestration reset</code> wiped messages this database once held.
        </p>
      )}
    </>
  );
}

/**
 * Amber, from the same palette as a `dispatched` node (`canvas/theme.ts`) — the page's one
 * colour for "read this before you believe the screen".
 */
const BANNER: CSSProperties = {
  margin: '4px 0',
  padding: '6px 10px',
  border: '1px solid #f59e0b',
  borderRadius: 4,
  background: '#fef3c7',
  color: '#78350f',
  fontSize: 12,
};

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

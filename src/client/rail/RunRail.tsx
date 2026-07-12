import { shortHandle } from '../../shared/handles.ts';
import type { CoordinatorRun, Run } from '../../shared/types.ts';
import { CHIP_STYLE } from '../chip.ts';
import { formatRunDate, statusBreakdown } from './summary.ts';

/**
 * The run rail — the panel that turns 76 tasks in one unreadable graph into a list of
 * orchestrations you can choose between.
 *
 * Two things it is contractually obliged to say out loud:
 *
 * 1. **"Runs (inferred)."** The schema has no run id. The grouping is a guess the server
 *    makes from terminal handles and idle gaps, and the header tells the user that rather
 *    than letting them believe Orca recorded it.
 * 2. **Which run is actually live.** The database is never pruned, so yesterday's run sits
 *    in the rail beside today's and renders through the exact same code path. There is no
 *    history mode — there is a list, and a green dot on the one that is still running.
 */

export type RunRailProps = {
  runs: Run[];
  coordinatorRuns: CoordinatorRun[];
  selectedId: string | null;
  onSelect: (runId: string) => void;
  /** A run that started while the user was reading an older one — announced, never jumped to. */
  newRunId: string | null;
};

export function RunRail({ runs, coordinatorRuns, selectedId, onSelect, newRunId }: RunRailProps) {
  return (
    <nav
      aria-label="Runs (inferred)"
      style={{
        width: 260,
        flexShrink: 0,
        borderRight: '1px solid #e4e4e7',
        overflowY: 'auto',
        padding: '12px 0',
      }}
    >
      <h2 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#71717a', margin: '0 12px 8px' }}>
        Runs (inferred)
      </h2>

      {/*
        No auto-jump (SPEC §7.3). A run appearing while you read an old one is *news*, not an
        instruction: the canvas is never yanked out from under you.
      */}
      {newRunId && (
        <button type="button" onClick={() => onSelect(newRunId)} style={{ ...CHIP_STYLE, margin: '0 12px 8px' }}>
          new run started ↑
        </button>
      )}

      {runs.length === 0 ? (
        // The canvas beside it already says what an empty database means; the rail only has to
        // say that it has nothing to list.
        <p style={{ margin: '0 12px', fontSize: 12, color: '#71717a' }}>No runs yet.</p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {runs.map((run) => (
            <li key={run.id}>
              <RunRow run={run} selected={run.id === selectedId} onSelect={() => onSelect(run.id)} />
            </li>
          ))}
        </ul>
      )}

      <CoordinatorRuns runs={coordinatorRuns} />
    </nav>
  );
}

/**
 * One run, and everything needed to pick it *without opening it* (SPEC §7.2): what it was
 * trying to do, when it ran, how big it was, and how it went.
 *
 * The full terminal handle rides in the tooltip. It is a uuid — it does not fit on the row,
 * and it is the only identity the orchestration has anywhere in the schema.
 */
function RunRow({ run, selected, onSelect }: { run: Run; selected: boolean; onSelect: () => void }) {
  const breakdown = statusBreakdown(run.statusCounts);

  return (
    <button
      type="button"
      data-testid="run-row"
      data-run={run.id}
      aria-current={selected}
      onClick={onSelect}
      title={run.handle ?? 'No terminal handle — Orca never attributed these tasks to one.'}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '8px 12px',
        border: 'none',
        borderLeft: `3px solid ${selected ? '#3b82f6' : 'transparent'}`,
        background: selected ? '#eff6ff' : 'transparent',
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <LiveDot live={run.live} />
        <b style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {run.label}
        </b>
      </span>

      <span style={{ display: 'block', paddingLeft: 14, fontSize: 11, color: '#71717a' }}>
        {formatRunDate(run.startedAt)} · {run.taskCount} {run.taskCount === 1 ? 'task' : 'tasks'}
        {breakdown && <> · {breakdown}</>}
      </span>
    </button>
  );
}

/**
 * Green when the run is genuinely live — which takes a running Orca *and* work still in
 * flight. The server decides it; a client that re-derived it from the task rows would call a
 * killed orchestration "running" forever, because nothing ever rewrites those rows.
 */
function LiveDot({ live }: { live: boolean }) {
  return (
    <span
      data-testid="live-dot"
      data-live={live}
      role="img"
      aria-label={live ? 'running now' : 'ended'}
      title={live ? 'Running now' : 'Ended'}
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        flexShrink: 0,
        background: live ? '#22c55e' : '#d4d4d8',
      }}
    />
  );
}

/**
 * Orca's built-in `Coordinator` loop writes these; agent- and CLI-driven coordination never
 * does, so the table is empty on every real database we have seen (SPEC §4.2, trap 3).
 *
 * It is rendered **if rows exist** and **nothing depends on it** — it is not, and cannot be,
 * the run-scoping key. Which is why this is a footnote under the rail and not the rail.
 */
function CoordinatorRuns({ runs }: { runs: CoordinatorRun[] }) {
  if (runs.length === 0) return null;

  return (
    <section data-testid="coordinator-runs" style={{ margin: '16px 12px 0', fontSize: 11, color: '#71717a' }}>
      <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, margin: '0 0 4px' }}>
        Coordinator runs
      </h3>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {runs.map((run) => (
          <li key={run.id} title={run.coordinatorHandle}>
            <code>{shortHandle(run.coordinatorHandle)}</code> · {run.status}
          </li>
        ))}
      </ul>
    </section>
  );
}


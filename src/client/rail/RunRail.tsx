import { ArrowUp, OctagonAlert } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CoordinatorRun, Run } from '../../shared/types.ts';
import { CHIP_CLASS } from '../chip.ts';
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
    <nav aria-label="Runs (inferred)" className="bg-card flex w-[17rem] min-h-0 shrink-0 flex-col border-r">
      <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
        <h2 className="text-muted-foreground text-[11px] font-semibold tracking-widest uppercase">
          Runs{' '}
          {/* The admission, and it is the header's — not a footnote you have to go and find. */}
          <span className="text-muted-foreground/60 font-normal normal-case">(inferred)</span>
        </h2>
        <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">{runs.length}</span>
      </div>

      {/*
        No auto-jump (SPEC §7.3). A run appearing while you read an old one is *news*, not an
        instruction: the canvas is never yanked out from under you.
      */}
      {newRunId && (
        <button type="button" onClick={() => onSelect(newRunId)} className={cn(CHIP_CLASS, 'mx-3 mb-2 cursor-pointer')}>
          <ArrowUp className="size-3" />
          new run started
        </button>
      )}

      <ScrollArea className="min-h-0 flex-1">
        {runs.length === 0 ? (
          // The canvas beside it already says what an empty database means; the rail only has to
          // say that it has nothing to list.
          <p className="text-muted-foreground px-4 text-xs">No runs yet.</p>
        ) : (
          <ul className="space-y-0.5 px-2 pb-2">
            {runs.map((run) => (
              <li key={run.id}>
                <RunRow run={run} selected={run.id === selectedId} onSelect={() => onSelect(run.id)} />
              </li>
            ))}
          </ul>
        )}

        <CoordinatorRuns runs={coordinatorRuns} />
      </ScrollArea>
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
      className={cn(
        'relative w-full cursor-pointer rounded-md py-2 pr-2.5 pl-3 text-left transition-colors',
        'hover:bg-accent/60 focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
        // The selected run wears the page's one blue, and a bar in it — the same "this is the
        // one you are looking at" the canvas outlines a node with.
        selected &&
          'bg-selection-soft/70 before:bg-selection hover:bg-selection-soft/70 before:absolute before:top-1.5 before:bottom-1.5 before:left-0 before:w-[3px] before:rounded-full'
      )}
    >
      <span className="flex items-center gap-2">
        <LiveDot live={run.live} />
        <b className="truncate text-[13px] font-semibold">{run.label}</b>
        <BlockedFlag blocked={run.hasOpenGates} />
      </span>

      <span className="text-muted-foreground mt-0.5 block pl-4 text-[11px]">
        {formatRunDate(run.startedAt)} · {run.taskCount} {run.taskCount === 1 ? 'task' : 'tasks'}
        {breakdown && <> · {breakdown}</>}
      </span>
    </button>
  );
}

/**
 * The octagon — this run is sitting on a question nobody has answered (`run.hasOpenGates`, #19).
 *
 * The rail's job is to let you pick the run worth opening without opening it (SPEC §7.2), and a
 * blocked run is the most worth opening there is: it is not slow, it is *stopped*, and it will
 * stay stopped until someone goes and answers it. The strip interrupts once you are inside the
 * run; this is what tells you which run to be inside.
 */
function BlockedFlag({ blocked }: { blocked: boolean }) {
  if (!blocked) return null;

  return (
    <OctagonAlert
      data-testid="run-gate-marker"
      role="img"
      aria-label="blocked on an open decision gate"
      className="text-gate ml-auto size-3.5 shrink-0"
    >
      <title>Blocked on an open decision gate</title>
    </OctagonAlert>
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
      className={cn(
        'relative size-2 shrink-0 rounded-full',
        live ? 'bg-status-completed' : 'bg-muted-foreground/35'
      )}
    >
      {/* A live run is the one thing on this rail that is *happening*, so it is the one thing
          that moves. Everything else holds still. */}
      {live && <span className="bg-status-completed absolute inset-0 animate-ping rounded-full opacity-60" />}
    </span>
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
    <section data-testid="coordinator-runs" className="text-muted-foreground mt-4 border-t px-4 py-3 text-[11px]">
      <h3 className="text-[10px] font-semibold tracking-widest uppercase">Coordinator runs</h3>
      <ul className="mt-1.5 space-y-1">
        {runs.map((run) => (
          <li key={run.id} title={run.coordinatorHandle} className="flex items-center gap-1.5">
            <code className="font-mono">{shortHandle(run.coordinatorHandle)}</code>
            <span className="opacity-70">· {run.status}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

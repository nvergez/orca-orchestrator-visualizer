import { useEffect, useRef, useState } from 'react';
import type { CoordinatorRun, Run, RunIndexPage, RunSnapshot, StreamEvent } from '../shared/types.ts';
import { useRunSelection } from './rail/selection.ts';

/**
 * How the client holds history now that the stream no longer carries it (#69, ADR 0002).
 *
 * The stream used to re-send every retained run, task and turn on every push, and the page
 * kept the whole of it in memory. It is now the **doorbell**: each event says *what changed*
 * (`StreamEvent.affected`), and this hook fetches exactly what the reader is looking at —
 *
 * - **the run index**, a page at a time (`GET /api/runs`): the first fifty summaries by
 *   default, older pages only when "Load older history" asks. On an invalidation the loaded
 *   *window* is re-read — bounded by what the reader chose to load, never by the size of
 *   history.
 * - **the selected-run snapshot** (`GET /api/run/:id`): one run, complete — refetched when a
 *   push names it, when the whole view may be stale (`affected.all`: connect and reconnect),
 *   or when the selection moves.
 *
 * The loaders are *values*, defaulting to the real fetches — the `loadTask` pattern
 * (`inspector/detail.ts`), for the same reason: `<App>` stays drivable by a canned world. A
 * canned loader may return its page **synchronously**, and the hook applies it synchronously,
 * which is what keeps the existing suite free of async choreography.
 */

/** A canned loader answers in place; the real one answers over the network. */
type MaybePromise<T> = T | Promise<T>;

export type HistoryLoaders = {
  /** One page of the run index; null cursor ⇒ the newest page. */
  index(cursor: string | null): MaybePromise<RunIndexPage>;
  /** One run, complete — or null when no run has this id any more (a 404). */
  run(runId: string): MaybePromise<RunSnapshot | null>;
};

/** The real transport: the two GETs of #69. */
export const fetchHistory: HistoryLoaders = {
  async index(cursor) {
    const response = await fetch(cursor === null ? '/api/runs' : `/api/runs?cursor=${encodeURIComponent(cursor)}`);
    if (!response.ok) throw new Error(`GET /api/runs → ${response.status}`);
    return (await response.json()) as RunIndexPage;
  },

  async run(runId) {
    const response = await fetch(`/api/run/${encodeURIComponent(runId)}`);
    // A 404 is a case, not a failure: an `orchestration reset` deletes runs the rail still
    // lists for one more tick. The refreshed index drops the row; this just stops waiting.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET /api/run/${runId} → ${response.status}`);
    return (await response.json()) as RunSnapshot;
  },
};

/** A failed fetch retries on its own; the stream cannot be relied on to ring again soon. */
const RETRY_MS = 5000;

export type History = {
  /** False until the first index page has landed — the shell shows "connecting" until then. */
  ready: boolean;
  /** The loaded window of summaries, most recently active first. */
  runs: Run[];
  coordinatorRuns: CoordinatorRun[];
  /** True while older pages exist beyond the window — what renders "Load older history". */
  hasOlder: boolean;
  loadOlder(): void;
  /** The rail's selection — most recent auto-opened once, never auto-jumped after (SPEC §7.3). */
  selected: Run | null;
  select(runId: string): void;
  newRunId: string | null;
  /**
   * The selected run, complete (`RunSnapshot`) — or null while it is first loading, or when
   * the run vanished under the selection. The previous run's evidence is never shown under a
   * new run's header.
   */
  snapshot: RunSnapshot | null;
};

type IndexState = {
  ready: boolean;
  runs: Run[];
  nextCursor: string | null;
  coordinatorRuns: CoordinatorRun[];
};

const EMPTY_INDEX: IndexState = { ready: false, runs: [], nextCursor: null, coordinatorRuns: [] };

export function useHistory(event: StreamEvent | null, loaders: HistoryLoaders): History {
  const [index, setIndex] = useState<IndexState>(EMPTY_INDEX);
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);

  // The loaders ride in a ref so an inline object is a re-render, not an infinite refetch —
  // the same defence `useTaskDetail` runs.
  const load = useRef(loaders);
  useEffect(() => {
    load.current = loaders;
  }, [loaders]);

  // The authoritative copy the callbacks read: state is the render's mirror of it. An epoch
  // outdates every in-flight answer the moment a newer question is asked — a page that arrives
  // after the window was replaced is not information, it is history's history.
  const indexRef = useRef<IndexState>(EMPTY_INDEX);
  const indexEpoch = useRef(0);
  const snapshotEpoch = useRef(0);

  const { selected, select, newRunId } = useRunSelection(index.runs);
  const selectedId = selected?.id ?? null;
  const selectedRef = useRef<string | null>(null);

  function applyIndex(state: IndexState): void {
    indexRef.current = state;
    setIndex(state);
  }

  /**
   * Re-read the loaded window, first page onward, **until it still holds every run the reader
   * had** — which is the whole of the rule, and it is not a row count.
   *
   * A count is what makes a window shrink under its reader. Refreshing "the newest N" after a
   * new orchestration started returns the newest N *including it*, and the oldest run the
   * reader had loaded falls off the bottom. If that was the run they were *reading*, the rail
   * can no longer find their selection and falls back to the top of the list — and the canvas
   * they were studying is replaced by the newest run, which is precisely the auto-jump SPEC
   * §7.3 forbids: "A run starting while you read a post-mortem is *news*, not an instruction."
   *
   * So the walk ends on **coverage, not arithmetic**. New runs sort ahead of everything, so
   * growth pushes the reader's tail *down* rather than out, and one more page is normally all
   * it takes. A run an `orchestration reset` deleted never arrives at all — the walk then ends
   * where it is always allowed to end, at the end of history, and the next refresh is bounded
   * again because the window it left behind no longer names the ghost.
   */
  function refreshWindow(): void {
    const epoch = ++indexEpoch.current;
    const held = new Set(indexRef.current.runs.map((run) => run.id));
    const collected: Run[] = [];

    const step = (cursor: string | null): void => {
      settle(
        load.current.index(cursor),
        (page) => {
          if (epoch !== indexEpoch.current) return;
          collected.push(...page.runs);

          const covered = collected.filter((run) => held.has(run.id)).length === held.size;
          if (page.nextCursor !== null && !covered) {
            step(page.nextCursor);
          } else {
            applyIndex({
              ready: true,
              runs: collected,
              nextCursor: page.nextCursor,
              coordinatorRuns: page.coordinatorRuns,
            });
          }
        },
        () => retry(epoch)
      );
    };

    const retry = (failedEpoch: number): void => {
      setTimeout(() => {
        if (failedEpoch === indexEpoch.current) refreshWindow();
      }, RETRY_MS);
    };

    step(null);
  }

  /**
   * One page further down (#69). A failure here needs no retry timer of its own: the cursor is
   * untouched, so the button is still standing and the way to try again is the way in was.
   */
  function loadOlder(): void {
    const cursor = indexRef.current.nextCursor;
    if (cursor === null) return;
    const epoch = indexEpoch.current;

    settle(load.current.index(cursor), (page) => {
      // Superseded by a refresh, or already followed (a double click): both mean this answer
      // no longer extends the window it was asked about.
      if (epoch !== indexEpoch.current || indexRef.current.nextCursor !== cursor) return;
      applyIndex({
        ready: true,
        runs: [...indexRef.current.runs, ...page.runs],
        nextCursor: page.nextCursor,
        coordinatorRuns: page.coordinatorRuns,
      });
    });
  }

  /** `keep` leaves the current evidence up while the refetch flies — a tick must not flicker. */
  function fetchSnapshot(runId: string, keep: boolean): void {
    const epoch = ++snapshotEpoch.current;
    if (!keep) setSnapshot(null);

    settle(
      load.current.run(runId),
      (fetched) => {
        if (epoch === snapshotEpoch.current) setSnapshot(fetched);
      },
      () => {
        setTimeout(() => {
          if (epoch === snapshotEpoch.current) fetchSnapshot(runId, true);
        }, RETRY_MS);
      }
    );
  }

  // The selection moved — a different run is a different canvas, loaded whole or not at all.
  // This effect sits *above* the event effect so `selectedRef` is current by the time a push
  // that landed in the same commit asks who is selected.
  useEffect(() => {
    selectedRef.current = selectedId;
    if (selectedId === null) {
      snapshotEpoch.current++;
      setSnapshot(null);
      return;
    }
    fetchSnapshot(selectedId, false);
  }, [selectedId]);

  // The doorbell. Each push is handled once: `affected` says whether the window and the
  // selected run are worth asking about again, and nothing is refetched that it did not name.
  useEffect(() => {
    if (event === null) return;
    const { all, runIds, unplaced } = event.affected;

    // `unplaced` touches the index only through the coordinator-runs footnote, but the refetch
    // is one bounded request — over-asking here is cheaper than a rule nobody can remember.
    if (all || runIds.length > 0 || unplaced) refreshWindow();

    const id = selectedRef.current;
    if (id !== null && (all || unplaced || runIds.includes(id))) fetchSnapshot(id, true);
  }, [event]);

  return {
    ready: index.ready,
    runs: index.runs,
    coordinatorRuns: index.coordinatorRuns,
    hasOlder: index.nextCursor !== null,
    loadOlder,
    selected,
    select,
    newRunId,
    // Never another run's evidence under this run's header — not even for the one render a
    // stale snapshot would take to replace.
    snapshot: snapshot !== null && snapshot.run.id === selectedId ? snapshot : null,
  };
}

/**
 * Apply an answer wherever it comes from: a canned loader answers in place — synchronously,
 * which is what keeps the suite free of async choreography — and the real one over the wire.
 */
function settle<T>(value: MaybePromise<T>, apply: (value: T) => void, failed: () => void = () => {}): void {
  if (value instanceof Promise) {
    value.then(apply, (error: unknown) => {
      console.error(`orca-viz: could not load run history — ${(error as Error).message}`);
      failed();
    });
  } else {
    apply(value);
  }
}

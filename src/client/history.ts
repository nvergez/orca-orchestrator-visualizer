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
  view: RunSnapshot | null;
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
  const [view, setView] = useState<RunSnapshot | null>(null);

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
  const viewEpoch = useRef(0);

  const { selected, select, newRunId } = useRunSelection(index.runs);
  const selectedId = selected?.id ?? null;
  const selectedRef = useRef<string | null>(null);

  function applyIndex(state: IndexState): void {
    indexRef.current = state;
    setIndex(state);
  }

  /**
   * Re-read the loaded window, first page onward, until it covers what the reader had — one
   * request in the common case, one per loaded page when they went digging. Anything less
   * would either shrink the window under them or leave rows in it that the doorbell just said
   * were stale.
   */
  function refreshWindow(): void {
    const epoch = ++indexEpoch.current;
    const target = Math.max(indexRef.current.runs.length, 1);
    const collected: Run[] = [];

    const step = (cursor: string | null): void => {
      settle(
        load.current.index(cursor),
        (page) => {
          if (epoch !== indexEpoch.current) return;
          collected.push(...page.runs);
          if (page.nextCursor !== null && collected.length < target) {
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
  function fetchView(runId: string, keep: boolean): void {
    const epoch = ++viewEpoch.current;
    if (!keep) setView(null);

    settle(
      load.current.run(runId),
      (snapshot) => {
        if (epoch === viewEpoch.current) setView(snapshot);
      },
      () => {
        setTimeout(() => {
          if (epoch === viewEpoch.current) fetchView(runId, true);
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
      viewEpoch.current++;
      setView(null);
      return;
    }
    fetchView(selectedId, false);
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
    if (id !== null && (all || unplaced || runIds.includes(id))) fetchView(id, true);
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
    view: view !== null && view.run.id === selectedId ? view : null,
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

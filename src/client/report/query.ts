import { useEffect, useRef, useState } from 'react';
import type {
  ReportDirection,
  ReportPage,
  ReportPresence,
  ReportRow,
  ReportSort,
  StreamEvent,
} from '../../shared/types.ts';

/**
 * How the client asks for the cross-history report (#70) — and it asks the *server*, every time.
 *
 * The sort, the filters and the paging are not the browser's: the database is never pruned, and a
 * client that ranked history itself would first have to hold the whole of it, which is the cost
 * #69 spent a whole ticket removing. So this module is thin on purpose — a view (what the reader
 * has chosen), a search string (what that means on the wire), and a hook that keeps one loaded
 * window of rows honest against a database that is still being written to.
 *
 * The loader is a *value* defaulting to the real fetch — the `loadTask` / `loadHistory` pattern
 * (`inspector/detail.ts`, `history.ts`), for the same reason: `<App>` stays drivable by a canned
 * world, and the canned world answers with the server's own `buildReport`, so a test cannot see a
 * page the endpoint would not have served (`test/client/canned.tsx`).
 */

/** A canned loader answers in place; the real one answers over the network. */
type MaybePromise<T> = T | Promise<T>;

/** `search` is the query string the server parses — cursor included. */
export type ReportLoader = (search: string) => MaybePromise<ReportPage>;

export const fetchReport: ReportLoader = async (search) => {
  const response = await fetch(`/api/report${search === '' ? '' : `?${search}`}`);
  if (!response.ok) throw new Error(`GET /api/report → ${response.status}`);
  return (await response.json()) as ReportPage;
};

/** A failed fetch retries on its own; the stream cannot be relied on to ring again soon. */
const RETRY_MS = 5000;

/**
 * What the reader has chosen. Null is "no filter" — never a magic value — and the two presence
 * filters are tri-state because *missing* is a first-class answer here: "what was never
 * dispatched" is the question a rail of runs can never be asked.
 */
export type ReportView = {
  sort: ReportSort;
  dir: ReportDirection;
  runId: string | null;
  status: string | null;
  /** One cast member's handle. */
  cast: string | null;
  /**
   * Whether the row has a named agent at all. `missing` is what the Agent select's "none" option
   * asks for — the tasks no terminal is on record as holding, which is the same absence the
   * column renders and so has to be one a reader can *find* (SPEC §12.4).
   */
  agent: ReportPresence;
  dispatch: ReportPresence;
  outcome: ReportPresence;
  /** `yyyy-mm-dd`, as an `<input type="date">` gives it. Both bounds are inclusive days. */
  from: string | null;
  to: string | null;
};

export const DEFAULT_VIEW: ReportView = {
  sort: 'dispatched',
  dir: 'desc',
  runId: null,
  status: null,
  cast: null,
  agent: 'any',
  dispatch: 'any',
  outcome: 'any',
  from: null,
  to: null,
};

export function isFiltered(view: ReportView): boolean {
  return (
    view.runId !== null ||
    view.status !== null ||
    view.cast !== null ||
    view.agent !== 'any' ||
    view.dispatch !== 'any' ||
    view.outcome !== 'any' ||
    view.from !== null ||
    view.to !== null
  );
}

/**
 * The view, as the wire asks it — and the one place the **days become instants**.
 *
 * The server's range reads the dispatch clock and its bounds are inclusive instants, so a reader
 * who picks the 8th as the end of their range means the *end* of the 8th: `to` is widened to the
 * last millisecond of the day, and `from` narrowed to its first. Doing it here, once, is what
 * keeps "tasks dispatched on the 8th" from quietly excluding everything after midnight.
 *
 * The days are read in **UTC**, like every instant on this wire (`time.ts`). A reader west of it
 * loses an hour at each end of the range rather than getting a boundary that moves with the
 * server's timezone — which is the trade the rest of the tool already makes.
 */
export function searchOf(view: ReportView, cursor: string | null): string {
  const params = new URLSearchParams();

  params.set('sort', view.sort);
  params.set('dir', view.dir);
  if (view.runId !== null) params.set('run', view.runId);
  if (view.status !== null) params.set('status', view.status);
  if (view.cast !== null) params.set('cast', view.cast);
  if (view.agent !== 'any') params.set('agent', view.agent);
  if (view.dispatch !== 'any') params.set('dispatch', view.dispatch);
  if (view.outcome !== 'any') params.set('outcome', view.outcome);
  if (view.from !== null) params.set('from', `${view.from}T00:00:00.000Z`);
  if (view.to !== null) params.set('to', `${view.to}T23:59:59.999Z`);
  if (cursor !== null) params.set('cursor', cursor);

  return params.toString();
}

export type Report = {
  /** False until the first page of this view has landed. */
  ready: boolean;
  rows: ReportRow[];
  /** How many rows the filters matched, across every page — what "50 of 214" is counting. */
  total: number;
  /** True while older rows exist beyond the loaded window. */
  hasMore: boolean;
  loadMore(): void;
  /** The read failed and is retrying. The rows already loaded stay on screen; they are not wrong. */
  failed: boolean;
  /**
   * The *next page* failed. It carries no retry of its own — the cursor is untouched, so the
   * button is still standing and the way to try again is the way in was (`useHistory.loadOlder`
   * runs the same reasoning). What it must not do is fail **silently**: "older rows are explicit"
   * (SPEC §12.4) is a promise a button that quietly did nothing would break.
   */
  moreFailed: boolean;
};

/** The pages the reader has loaded, and where the next one starts. */
type Loaded = { ready: boolean; rows: ReportRow[]; nextCursor: string | null; total: number; pages: number };

const EMPTY: Loaded = { ready: false, rows: [], nextCursor: null, total: 0, pages: 0 };

/**
 * One loaded window of the report, kept honest against a database that is still being written to.
 *
 * Two rules, and the second is the one worth reading twice:
 *
 * - **A new view is a new window.** Changing the sort or a filter re-anchors the cursor chain from
 *   the first page, because a keyset position measured in one order means nothing in another —
 *   which the server refuses outright rather than answering (`report.ts`).
 * - **A push re-walks the window it already has, and never grows it.** The doorbell says a run's
 *   evidence moved (`StreamEvent.affected`); the report cannot know which *rows* that touched — a
 *   completed dispatch changes a duration, which moves a row in a duration sort — so it re-reads
 *   the pages the reader loaded, in order, and replaces them. The cost is bounded by what the
 *   reader chose to load, never by the size of history. Under an unchanged database the re-walk
 *   returns exactly the same rows, which is what the total order is for.
 *
 * The panel is *mounted* while the report is open and unmounted when it closes (`App.tsx`), which
 * is what makes reopening a fresh read — so there is no `open` flag here to get wrong.
 */
export function useReport(event: StreamEvent | null, view: ReportView, loader: ReportLoader): Report {
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [failed, setFailed] = useState(false);
  const [moreFailed, setMoreFailed] = useState(false);

  // The loader rides in a ref so an inline value is a re-render, not an infinite refetch — the
  // same defence `useHistory` and `useTaskDetail` run.
  const load = useRef(loader);
  useEffect(() => {
    load.current = loader;
  }, [loader]);

  // The authoritative copy the callbacks read; state is the render's mirror of it. The epoch
  // outdates every in-flight answer the moment a newer question is asked — a page that arrives
  // after the view changed is not information.
  const held = useRef<Loaded>(EMPTY);
  const epoch = useRef(0);

  function apply(next: Loaded): void {
    held.current = next;
    setLoaded(next);
  }

  /** Re-read `pages` pages from the top, following each page's own cursor. */
  function walk(pages: number): void {
    const mine = ++epoch.current;
    const collected: ReportRow[] = [];

    const step = (cursor: string | null, remaining: number): void => {
      settle(
        load.current(searchOf(view, cursor)),
        (page) => {
          if (mine !== epoch.current) return;
          collected.push(...page.rows);

          if (page.nextCursor !== null && remaining > 1) {
            step(page.nextCursor, remaining - 1);
            return;
          }

          apply({
            ready: true,
            rows: collected,
            nextCursor: page.nextCursor,
            total: page.total,
            // What was *served*, not what was asked for: a window that shrank because history did
            // must not keep claiming pages the server no longer has.
            pages: pages - remaining + 1,
          });
        },
        () => {
          if (mine !== epoch.current) return;
          // The rows already on screen are not wrong — they are what the database said. The read
          // is retried behind them rather than replacing them with an error.
          apply({ ...held.current, ready: true });
          setFailed(true);
          setTimeout(() => {
            if (mine === epoch.current) walk(pages);
          }, RETRY_MS);
        }
      );
    };

    setFailed(false);
    step(null, Math.max(1, pages));
  }

  /** One page further down. The cursor is the server's, followed verbatim. */
  function loadMore(): void {
    const cursor = held.current.nextCursor;
    if (cursor === null) return;
    const mine = epoch.current;

    setMoreFailed(false);

    settle(
      load.current(searchOf(view, cursor)),
      (page) => {
        // Superseded by a re-walk, or already followed (a double click): either way this answer no
        // longer extends the window it was asked about.
        if (mine !== epoch.current || held.current.nextCursor !== cursor) return;
        apply({
          ready: true,
          rows: [...held.current.rows, ...page.rows],
          nextCursor: page.nextCursor,
          total: page.total,
          pages: held.current.pages + 1,
        });
      },
      () => {
        // No retry timer: the cursor is untouched, so the button is still standing and pressing it
        // again *is* the retry. What is owed is that the failure be **said** — a page of history
        // that silently did not arrive is history the reader now believes is not there.
        if (mine === epoch.current) setMoreFailed(true);
      }
    );
  }

  // A new sort or filter is a new window, from its first page — `key` is the view, flattened.
  const key = searchOf(view, null);
  useEffect(() => {
    walk(1);
  }, [key]);

  // The doorbell (#69). Anything that moved may have moved a row: a completed dispatch changes a
  // duration, a new result changes an outcome, a new task adds a row above this one. So any named
  // change re-walks the loaded window — over-asking, deliberately, because the alternative is a
  // report that is silently stale.
  useEffect(() => {
    if (event === null || !held.current.ready) return;
    const { all, runIds, unplaced } = event.affected;
    if (all || runIds.length > 0 || unplaced) walk(held.current.pages);
  }, [event]);

  return {
    ready: loaded.ready,
    rows: loaded.rows,
    total: loaded.total,
    hasMore: loaded.nextCursor !== null,
    loadMore,
    failed,
    moreFailed,
  };
}

/**
 * Apply an answer wherever it comes from: a canned loader answers in place — synchronously, which
 * is what keeps the suite free of async choreography — and the real one over the wire.
 */
function settle<T>(value: MaybePromise<T>, apply: (value: T) => void, failed: () => void = () => {}): void {
  if (value instanceof Promise) {
    value.then(apply, (error: unknown) => {
      console.error(`orca-viz: could not load the report — ${(error as Error).message}`);
      failed();
    });
  } else {
    apply(value);
  }
}

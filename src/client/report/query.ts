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
  /** A cast member's handle. Never-dispatched work has no agent — `dispatch: 'missing'` asks for it. */
  agent: string | null;
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
  agent: null,
  dispatch: 'any',
  outcome: 'any',
  from: null,
  to: null,
};

export function isFiltered(view: ReportView): boolean {
  return (
    view.runId !== null ||
    view.status !== null ||
    view.agent !== null ||
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
  if (view.agent !== null) params.set('agent', view.agent);
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
};

type Window = { ready: boolean; rows: ReportRow[]; nextCursor: string | null; total: number; pages: number };

const EMPTY: Window = { ready: false, rows: [], nextCursor: null, total: 0, pages: 0 };

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
 */
export function useReport(
  open: boolean,
  event: StreamEvent | null,
  view: ReportView,
  loader: ReportLoader
): Report {
  const [window, setWindow] = useState<Window>(EMPTY);
  const [failed, setFailed] = useState(false);

  // The loader rides in a ref so an inline value is a re-render, not an infinite refetch — the
  // same defence `useHistory` and `useTaskDetail` run.
  const load = useRef(loader);
  useEffect(() => {
    load.current = loader;
  }, [loader]);

  // The authoritative copy the callbacks read; state is the render's mirror of it. The epoch
  // outdates every in-flight answer the moment a newer question is asked — a page that arrives
  // after the view changed is not information.
  const windowRef = useRef<Window>(EMPTY);
  const epoch = useRef(0);

  function apply(next: Window): void {
    windowRef.current = next;
    setWindow(next);
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
          apply({ ...windowRef.current, ready: true });
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
    const cursor = windowRef.current.nextCursor;
    if (cursor === null) return;
    const mine = epoch.current;

    settle(load.current(searchOf(view, cursor)), (page) => {
      // Superseded by a re-walk, or already followed (a double click): either way this answer no
      // longer extends the window it was asked about.
      if (mine !== epoch.current || windowRef.current.nextCursor !== cursor) return;
      apply({
        ready: true,
        rows: [...windowRef.current.rows, ...page.rows],
        nextCursor: page.nextCursor,
        total: page.total,
        pages: windowRef.current.pages + 1,
      });
    });
  }

  // A closed report fetches nothing, and reopening is a fresh read: the rows behind a panel
  // nobody is looking at are the one thing in this tool that is allowed to be forgotten.
  const key = open ? searchOf(view, null) : null;
  useEffect(() => {
    if (key === null) {
      epoch.current++;
      apply(EMPTY);
      return;
    }
    walk(1);
    // `key` is the view, flattened — a new sort or filter is a new window, from its first page.
  }, [key]);

  // The doorbell (#69). Anything that moved may have moved a row: a completed dispatch changes a
  // duration, a new result changes an outcome, a new task adds a row above this one. So any named
  // change re-walks the loaded window — over-asking, deliberately, because the alternative is a
  // report that is silently stale.
  useEffect(() => {
    if (!open || event === null || !windowRef.current.ready) return;
    const { all, runIds, unplaced } = event.affected;
    if (all || runIds.length > 0 || unplaced) walk(windowRef.current.pages);
  }, [event]);

  return {
    ready: window.ready,
    rows: window.rows,
    total: window.total,
    hasMore: window.nextCursor !== null,
    loadMore,
    failed,
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

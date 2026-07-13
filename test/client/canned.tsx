import { useMemo } from 'react';
import { App } from '../../src/client/App.tsx';
import type { Connection } from '../../src/client/connection.ts';
import type { HistoryLoaders } from '../../src/client/history.ts';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { ReportLoader } from '../../src/client/report/query.ts';
import { pageRuns, type RunEvidence, snapshotRun } from '../../src/server/history.ts';
import { buildReport, parseReportQuery } from '../../src/server/report.ts';
import { mergeReceipts } from '../../src/shared/receipt.ts';
import type {
  CoordinatorRun,
  Dispatch,
  Gate,
  ReceiptFact,
  ReportPage,
  Run,
  RunIndexPage,
  RunSnapshot,
  StreamEvent,
  Task,
  Turn,
} from '../../src/shared/types.ts';

/**
 * Seam 2 (#12), after #69: `<App>` driven by a canned world.
 *
 * The stream stopped carrying history — it is the doorbell, and the data is `GET /api/runs`
 * and `GET /api/run/:id` (`src/client/history.ts`). A canned shell therefore needs canned
 * *loaders* beside the canned event, and this wrapper builds them from the same full-history
 * arrays the suites have always written, so a presentation test still describes one world in
 * one place.
 *
 * Two things make the stub honest rather than convenient:
 *
 * - **It answers synchronously.** `useHistory` applies an in-place answer in place, so every
 *   existing `getBy*` keeps reading a settled screen — no async choreography leaks into a
 *   hundred presentation tests that were never about the transport.
 * - **It scopes with the server's own functions.** `pageRuns` and `snapshotRun` are pure and
 *   imported from `src/server/history.ts`, so what a canned selected run contains cannot
 *   drift from what the real endpoint would serve — the unwitting-fixture trap (SPEC §4.7)
 *   guarded the conversation this way first.
 *
 * The *transport itself* — pages, targeted refetch, growth while disconnected — is asserted
 * against the real `<Live>` composition with a faked wire in `live.test.tsx`, and over real
 * HTTP in `test/server/history.test.ts`.
 */

/**
 * A stream event with the canned world riding beside it — the shape the presentation suites
 * have always written. The wire's `StreamEvent` stopped carrying `snapshot` (#69); here it is
 * the *fixture*: `historyOf` turns it into the loaders the paged contracts would have served
 * it through, and `CannedApp` hands `<App>` only the wire part.
 */
export type CannedEvent = StreamEvent & {
  snapshot: { runs: Run[]; tasks: Task[]; gates: Gate[]; turns: Turn[]; coordinatorRuns: CoordinatorRun[] };
};

/**
 * The canned world as the server's own derivations see it.
 *
 * `receiptsByTask` is the one piece a canned event does not already spell out, and it is derived
 * here from the turns the test wrote — a `result` or `worker_done` turn's `receipt` is exactly
 * the recognized facts of the task it belongs to (#67), and `mergeReceipts` merges them the way
 * the server merges its two evidence columns. So a canned report row summarizes the same facts
 * the canned conversation shows, which is the whole point of writing one world in one place.
 */
function evidenceOf(event: CannedEvent, attempts: Record<string, Dispatch[]>): RunEvidence {
  const receipts = new Map<string, ReceiptFact[]>();

  for (const turn of event.snapshot.turns) {
    if (turn.taskId === null || turn.receipt === undefined || turn.receipt.length === 0) continue;
    receipts.set(turn.taskId, mergeReceipts(receipts.get(turn.taskId) ?? [], turn.receipt));
  }

  return {
    runs: event.snapshot.runs,
    tasks: event.snapshot.tasks,
    attemptsByTask: new Map(Object.entries(attempts)),
    gates: event.snapshot.gates,
    turns: event.snapshot.turns,
    coordinatorRuns: event.snapshot.coordinatorRuns,
    receiptsByTask: receipts,
  };
}

export function historyOf(event: CannedEvent, attempts: Record<string, Dispatch[]> = {}): HistoryLoaders {
  const evidence = evidenceOf(event, attempts);

  return {
    index(cursor): RunIndexPage {
      const page = pageRuns(evidence.runs, cursor);
      return {
        meta: event.meta,
        runs: page.runs,
        nextCursor: page.nextCursor,
        coordinatorRuns: evidence.coordinatorRuns,
      };
    },

    run(id): RunSnapshot | null {
      const snapshot = snapshotRun(evidence, id);
      return snapshot === null ? null : { meta: event.meta, ...snapshot };
    },
  };
}

/**
 * `GET /api/report` (#70), served from the canned world by the server's own `buildReport` — so a
 * canned page cannot rank, filter or page differently from the real one. The query travels as
 * the search string the client really builds, and it is parsed by the same parser the endpoint
 * uses: a test that sends a query the server would refuse gets the refusal, not a lucky answer.
 */
export function reportOf(event: CannedEvent, attempts: Record<string, Dispatch[]> = {}): ReportLoader {
  const evidence = evidenceOf(event, attempts);

  return (search: string): ReportPage => ({
    meta: event.meta,
    ...buildReport(evidence, parseReportQuery(new URLSearchParams(search))),
  });
}

/** Loaders for the null event — never called, because the doorbell never rings. */
const NO_HISTORY: HistoryLoaders = {
  index: () => {
    throw new Error('no event has arrived — nothing should be fetching history yet');
  },
  run: () => {
    throw new Error('no event has arrived — nothing should be fetching a run yet');
  },
};

const NO_REPORT: ReportLoader = () => {
  throw new Error('no event has arrived — nothing should be fetching the report yet');
};

export function CannedApp({
  event,
  loadTask,
  attempts,
  connection,
  appliedAt,
}: {
  event: CannedEvent | null;
  loadTask?: TaskLoader;
  /**
   * Every dispatch attempt per task — the retry record a `Task` folds down to its latest
   * (`RunSnapshot.attempts`). The report's failure count reads them, so a suite that is *about*
   * failures writes them here; every other suite leaves them out, as the wire does.
   */
  attempts?: Record<string, Dispatch[]>;
  /**
   * The transport's own story (#57) — what the `EventSource` is doing, and when the last event
   * was applied. They are `<App>`'s props verbatim, passed straight through: they say nothing
   * about the canned *world*, only about the wire that would have delivered it, so a suite that
   * is about the top bar sets them and every other suite lets them default.
   */
  connection?: Connection;
  appliedAt?: number | null;
}) {
  // Rebuilt when the event is: a rerender with a new world is a new database state, and the
  // event's `affected.all` is what makes `useHistory` re-read it — exactly a real reconnect.
  const loadHistory = useMemo(() => (event === null ? NO_HISTORY : historyOf(event, attempts)), [event, attempts]);
  const loadReport = useMemo(() => (event === null ? NO_REPORT : reportOf(event, attempts)), [event, attempts]);

  return (
    <App
      event={event}
      loadTask={loadTask}
      loadHistory={loadHistory}
      loadReport={loadReport}
      connection={connection}
      appliedAt={appliedAt}
    />
  );
}

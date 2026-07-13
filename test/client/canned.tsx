import { useMemo } from 'react';
import { App } from '../../src/client/App.tsx';
import type { HistoryLoaders } from '../../src/client/history.ts';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import { pageRuns, type RunEvidence, snapshotRun } from '../../src/server/history.ts';
import type {
  CoordinatorRun,
  Dispatch,
  Gate,
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

export function historyOf(event: CannedEvent, attempts: Record<string, Dispatch[]> = {}): HistoryLoaders {
  const evidence: RunEvidence = {
    runs: event.snapshot.runs,
    tasks: event.snapshot.tasks,
    attemptsByTask: new Map(Object.entries(attempts)),
    gates: event.snapshot.gates,
    turns: event.snapshot.turns,
    coordinatorRuns: event.snapshot.coordinatorRuns,
  };

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

/** Loaders for the null event — never called, because the doorbell never rings. */
const NO_HISTORY: HistoryLoaders = {
  index: () => {
    throw new Error('no event has arrived — nothing should be fetching history yet');
  },
  run: () => {
    throw new Error('no event has arrived — nothing should be fetching a run yet');
  },
};

/** A run whose tasks were never dispatched — the shape most presentation suites want. */
const NO_ATTEMPTS: Record<string, Dispatch[]> = {};

export function CannedApp({
  event,
  loadTask,
  /**
   * Every retained attempt of every task, as the selected-run snapshot carries them (`RunSnapshot`).
   * Most suites need none — a canvas node shows the *latest* dispatch, which rides on the `Task`.
   * The timeline (#72) is the panel that reads the attempt rows themselves, because a retry is one
   * task and several rows, and the bar per attempt is the whole feature.
   */
  attempts = NO_ATTEMPTS,
}: {
  event: CannedEvent | null;
  loadTask?: TaskLoader;
  attempts?: Record<string, Dispatch[]>;
}) {
  // Rebuilt when the event is: a rerender with a new world is a new database state, and the
  // event's `affected.all` is what makes `useHistory` re-read it — exactly a real reconnect.
  const loadHistory = useMemo(() => (event === null ? NO_HISTORY : historyOf(event, attempts)), [event, attempts]);
  return <App event={event} loadTask={loadTask} loadHistory={loadHistory} />;
}

import type { AddressInfo } from 'node:net';
import { type DatabaseDeps, OrcaDatabase } from '../../src/server/database.ts';
import { createServer, type ServerOptions } from '../../src/server/server.ts';
import type {
  CoordinatorRun,
  Gate,
  Run,
  RunIndexPage,
  RunSnapshot,
  StreamEvent,
  Task,
  Turn,
} from '../../src/shared/types.ts';
import { openStream, type SseStream } from './sse.ts';

/**
 * Seam 1 (#12): the real server, over real HTTP, against a real fixture database. No
 * driver mock, no test-only route — a test sees exactly what `curl` sees.
 */

/**
 * The whole of retained history, reassembled from the paged contracts of #69 — every index
 * page walked, every run's selected-run snapshot fetched, and the pieces merged back into the
 * shape the wire used to carry.
 *
 * The derivation suites (runs, tasks, gates, the conversation) assert against this, and that
 * is deliberate: the wire stopped shipping full history, but "what does the server derive from
 * this database" is still the question those suites ask — so the harness asks it the only way
 * a client now can, through `GET /api/runs` and `GET /api/run/:id`. Nothing here peeks behind
 * the HTTP edge.
 *
 * Order within a run is the server's (creation order for tasks, chronology for turns); runs
 * are merged in index order, and the turns nothing places — which every selected-run snapshot
 * carries — appear once, at the end.
 */
export type MergedHistory = {
  runs: Run[];
  tasks: Task[];
  gates: Gate[];
  turns: Turn[];
  coordinatorRuns: CoordinatorRun[];
};

/** A stream event, with the reassembled history riding beside it for assertions. */
export type SnapshotView = StreamEvent & { snapshot: MergedHistory };

export type Harness = {
  origin: string;
  dbPath: string;
  /**
   * `GET /api/snapshot` — plus the reassembled `snapshot` (see `MergedHistory`). `since`
   * mirrors a replayed `Last-Event-ID`: omitted is a first connect (no message backfill);
   * a number is the lossless delta after that cursor.
   */
  snapshot(since?: number): Promise<SnapshotView>;
  /** An SSE client on `/api/stream`, optionally resuming from a `Last-Event-ID` (#17). */
  stream(lastEventId?: number): Promise<SseStream>;
  /**
   * `GET /api/task/:id` — the lazy detail (#20). The raw `Response`, not the parsed body: this
   * is the one route with a 404 in it, and a helper that threw on it would hide the case.
   */
  task(id: string): Promise<Response>;
  /** `GET /api/runs` — one page of the run index (#69). Raw, because a bad cursor is a 400. */
  runs(cursor?: string): Promise<Response>;
  /**
   * `GET /api/report` — one page of the cross-history report (#70). Raw, because every way of
   * asking it for something it cannot honour is a 400.
   */
  report(query?: string): Promise<Response>;
  /** `GET /api/run/:id` — the selected-run snapshot (#69). Raw, because an unknown id is a 404. */
  run(id: string): Promise<Response>;
  /**
   * `GET /api/run/:id/archive` — the one-shot export (#74). Raw: the headers *are* the download
   * (`Content-Disposition`), an unknown id is a 404, and both are the contract under test.
   */
  archive(id: string): Promise<Response>;
  close(): Promise<void>;
};

export type ServeOptions = DatabaseDeps & {
  /**
   * The poll cadence. Production is 5000 ms (SPEC §6.1), and a suite that waited that out
   * would take minutes — so the tests turn the same dial `--poll-interval` turns. The loop
   * under test is the real one; only its period is small.
   */
  pollIntervalMs?: number;
  /** The wake hint (#59) — the same dial `--watch` turns, deps and all. Absent = poll only. */
  watch?: ServerOptions['watch'];
  /** The #61 opt-in, with a scripted CLI — the same dial `--orca-enrichment` turns. */
  enrichment?: ServerOptions['enrichment'];
};

/** Serve a fixture database. `probe` fakes the process table so liveness is testable. */
export async function serve(
  dbPath: string,
  { pollIntervalMs = 20, watch, enrichment, ...deps }: ServeOptions = {}
): Promise<Harness> {
  const database = new OrcaDatabase(dbPath, deps);
  const { server, close } = createServer({
    database,
    pollIntervalMs,
    watch,
    clientDir: '/nonexistent-bundle',
    // Fast, like the poll interval: a suite must not wait a production cadence out.
    enrichment: enrichment === undefined ? undefined : { intervalMs: 25, ...enrichment },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const streams: SseStream[] = [];

  async function getJson<T>(path: string): Promise<T> {
    const response = await fetch(`${origin}${path}`);
    if (!response.ok) throw new Error(`GET ${path} → ${response.status}`);
    return (await response.json()) as T;
  }

  /** Walk the paged contracts and merge — see `MergedHistory`. */
  async function history(): Promise<MergedHistory> {
    const runs: Run[] = [];
    let coordinatorRuns: CoordinatorRun[] | undefined;
    let cursor: string | null = null;

    do {
      const query: string = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      const page = await getJson<RunIndexPage>(`/api/runs${query}`);
      runs.push(...page.runs);
      coordinatorRuns = page.coordinatorRuns;
      cursor = page.nextCursor;
    } while (cursor !== null);

    const tasks: Task[] = [];
    const gates: Gate[] = [];
    const turns: Turn[] = [];
    // Every selected-run snapshot carries the turns nothing places (SPEC §4.4, rule 3), so the
    // merge would otherwise repeat them once per run.
    const unplaced = new Map<string, Turn>();

    for (const run of runs) {
      const snapshot = await getJson<RunSnapshot>(`/api/run/${encodeURIComponent(run.id)}`);
      tasks.push(...snapshot.tasks);
      gates.push(...snapshot.gates);
      for (const turn of snapshot.turns) {
        if (turn.runId === run.id) turns.push(turn);
        else unplaced.set(turn.id, turn);
      }
    }

    return { runs, tasks, gates, turns: [...turns, ...unplaced.values()], coordinatorRuns: coordinatorRuns ?? [] };
  }

  return {
    origin,
    dbPath,

    async snapshot(since) {
      const query = since === undefined ? '' : `?since=${since}`;
      const event = await getJson<StreamEvent>(`/api/snapshot${query}`);
      return { ...event, snapshot: await history() };
    },

    async stream(lastEventId) {
      const stream = await openStream(origin, lastEventId);
      streams.push(stream);
      return stream;
    },

    async task(id) {
      return fetch(`${origin}/api/task/${encodeURIComponent(id)}`);
    },

    async runs(cursor) {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
      return fetch(`${origin}/api/runs${query}`);
    },

    async report(query) {
      return fetch(`${origin}/api/report${query === undefined || query === '' ? '' : `?${query}`}`);
    },

    async run(id) {
      return fetch(`${origin}/api/run/${encodeURIComponent(id)}`);
    },

    async archive(id) {
      return fetch(`${origin}/api/run/${encodeURIComponent(id)}/archive`);
    },

    async close() {
      await Promise.all(streams.map((stream) => stream.close()));
      await close();
      database.close();
    },
  };
}

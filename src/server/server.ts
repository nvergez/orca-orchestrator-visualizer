import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, DEFAULT_POLL_INTERVAL_MS } from './cli.ts';
import type { OrcaDatabase } from './database.ts';
import { type EnrichmentOptions, OrcaEnrichment, withEnrichment } from './enrichment.ts';
import { CursorError } from './history.ts';
import { parseReportQuery, ReportQueryError } from './report.ts';
import { EventStream, type StreamClient, type StreamSource } from './stream.ts';
import { type WakeDeps, type WakeWatcher, watchForWakeHints } from './wake.ts';

/** dist/server/server.js and dist/client/ are siblings once the package is built. */
export const CLIENT_DIR = fileURLToPath(new URL('../client', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** `GET /api/task/:id` — everything after this prefix is the id (#20). */
const TASK_ROUTE = '/api/task/';

/** `GET /api/run/:id` — the selected-run snapshot (#69). Everything after the prefix is the id. */
const RUN_ROUTE = '/api/run/';

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  // The two things a long-lived push response has to say for itself. There is no proxy on
  // loopback to defeat, but a browser will happily cache a stream it was never told not to.
  'cache-control': 'no-cache',
  connection: 'keep-alive',
};

/**
 * Resolve a request path to a file inside the client bundle, or null when it escapes
 * the bundle directory (`..`, absolute paths, encoded traversal).
 */
function resolveAsset(clientDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // A malformed escape (`/%`) — decodeURIComponent throws on it.
  }
  const candidate = normalize(join(clientDir, decoded));
  if (candidate !== clientDir && !candidate.startsWith(clientDir + sep)) return null;
  return candidate;
}

export type ServerOptions = {
  /** The database, already open and read-only. */
  database: OrcaDatabase;
  /** How often the poll loop looks for a change — `--poll-interval` (SPEC §6.1). */
  pollIntervalMs?: number;
  /** Where the built frontend lives. Defaults to the bundle this package ships. */
  clientDir?: string;
  /**
   * The optional wake hint (#59, `--watch`): watch the database directory and run the normal
   * tick early on a change. Absent means poll only; `{}` means watch with the defaults. What
   * a wake may do is bounded by `EventStream.tick` itself — the `data_version` gate decides
   * whether anything is queried or pushed, exactly as it does on the interval.
   */
  watch?: WakeDeps;
  /**
   * Live Orca context (#61) — the explicit opt-in behind `--orca-enrichment`. Absent means
   * **off**: no adapter exists, no `orca` command ever runs, and the wire carries no
   * `enrichment` field. `{}` turns the real CLI on with its defaults; tests inject `run`.
   */
  enrichment?: EnrichmentOptions;
};

/**
 * A listening orca-viz: the HTTP server, and the one call that takes everything down.
 *
 * `close()` exists because an SSE response never ends on its own. `server.close()` waits for
 * open connections to finish, and a browser holding a stream open would keep it waiting for
 * ever — so the streams are ended first, and only then does the server stop listening.
 */
export type Viz = { server: Server; close(): Promise<void> };

/**
 * The web server: one process, one port, serving both the JSON API and the frontend.
 *
 * Two routes return a `StreamEvent`, and they are deliberately the same event from the same
 * call: `GET /api/stream` pushes one whenever the database changes (#17), and
 * `GET /api/snapshot` returns one and hangs up — which makes the whole tool `curl`-debuggable
 * and is the seam the server tests drive (#12). `GET /api/task/:id` (#20) is the only route
 * that returns something else, because it is the only one that reads the bodies.
 */
export function createServer({
  database,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  clientDir = CLIENT_DIR,
  watch,
  enrichment,
}: ServerOptions): Viz {
  // The adapter is constructed only behind the opt-in — while it is off, the code that could
  // spawn an `orca` process does not exist here to be reached (#61). When it is on, *both*
  // event-shaped routes serve the wrapped source: two views of the enrichment could disagree,
  // and /api/snapshot is documented as the same event the stream pushes.
  const adapter = enrichment === undefined ? null : new OrcaEnrichment(() => database.liveness(), enrichment);
  const source: StreamSource = adapter === null ? database : withEnrichment(database, adapter);
  adapter?.start();

  const stream = new EventStream(source, pollIntervalMs);

  // The watcher may only ever run the tick the interval was going to run anyway — earlier.
  // Its failures are its own: setup or runtime trouble warns once inside `wake.ts` and leaves
  // `stream` polling as if `--watch` had never been passed.
  const watcher: WakeWatcher | null =
    watch === undefined ? null : watchForWakeHints(database.path, () => stream.tick(), watch);

  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`);
    const urlPath = url.pathname;

    if (urlPath === '/api/stream') {
      openStream(stream, req, res);
      return;
    }

    if (urlPath === '/api/snapshot') {
      // The *wrapped* source, never the bare database: while the opt-in is on, both
      // event-shaped routes must serve the same enrichment, or two views of it would disagree.
      sendSnapshot(source, url.searchParams.get('since'), res);
      return;
    }

    if (urlPath === '/api/runs') {
      sendRunIndex(database, url.searchParams.get('cursor'), res);
      return;
    }

    if (urlPath === '/api/report') {
      sendReport(database, url.searchParams, res);
      return;
    }

    if (urlPath.startsWith(RUN_ROUTE)) {
      sendById(
        urlPath.slice(RUN_ROUTE.length),
        (id) => database.runSnapshot(id),
        (id) => `No run ${id} in this database.`,
        res
      );
      return;
    }

    if (urlPath.startsWith(TASK_ROUTE)) {
      sendById(
        urlPath.slice(TASK_ROUTE.length),
        (id) => database.taskDetail(id),
        (id) => `No task ${id} in this database.`,
        res
      );
      return;
    }

    const filePath = resolveAsset(clientDir, urlPath === '/' ? '/index.html' : urlPath);

    if (!filePath) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Forbidden');
      return;
    }

    readFile(filePath)
      .then((body) => {
        res.writeHead(200, {
          'content-type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        });
        res.end(body);
      })
      .catch(() => {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
      });
  });

  return {
    server,
    async close() {
      // The watcher goes down with the streams it existed to hurry: its fs handle and any
      // debounce still in flight, released before the port. (A straggler wake would be
      // harmless — a tick with no subscribers reads nothing — but "harmless" is not a
      // lifecycle, and the caller is about to close the database out from under everything.)
      watcher?.close();
      // Likewise the enrichment adapter's own timer, and any `orca` child still in flight:
      // nothing may outlive the server that opted into it.
      adapter?.stop();
      stream.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/**
 * `GET /api/stream` — SSE, and the reason the page keeps up with the agents.
 *
 * The whole of the resume story is `lastEventId(req)`: the browser replays the id of the last
 * event it saw, that id *is* our message cursor, and what it gets back is one full snapshot
 * plus exactly what it missed. No resync mode, no client-side bookkeeping, no code of ours
 * between `EventSource` reconnecting and `messages.sequence`.
 */
function openStream(stream: EventStream, req: IncomingMessage, res: ServerResponse): void {
  const client: StreamClient = {
    send(event) {
      // Headers on the first push rather than on connect: a first read that throws is then
      // still an HTTP error the browser will retry, instead of a 200 carrying an error frame
      // that `StreamEvent` — one event type — has nowhere to put.
      if (!res.headersSent) res.writeHead(200, SSE_HEADERS);
      res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    },
    end() {
      res.end();
    },
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = stream.subscribe(client, lastEventId(req));
  } catch (error) {
    sendError(res, error);
    return;
  }

  // The tab was closed, or the browser is already reconnecting. Either way, this client is gone.
  res.on('close', unsubscribe);
}

/**
 * The cursor a reconnecting `EventSource` replays — or null when there is none to honor.
 *
 * Absent means a first connect: the client has seen nothing, has therefore missed nothing,
 * and gets no backfill — history is `GET /api/runs` and `GET /api/run/:id`'s to serve (#69).
 * Present — **zero included**, because a browser that last saw event id 0 will replay exactly
 * that — means "everything after this", losslessly. Nonsense from a hand-rolled client is
 * treated as absent: there is no cursor in it to be lossless *from*.
 */
function lastEventId(req: IncomingMessage): number | null {
  const header = req.headers['last-event-id'];
  const value = Number(Array.isArray(header) ? header[0] : header);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * A read can throw — the database can be deleted, or Orca can checkpoint it out from under
 * us. A 500 with the reason keeps the process up and tells the user which of those it was; a
 * thrown exception here would take the whole tool down mid-poll.
 *
 * `?since=<seq>` is the reconnect view, `curl`-able: the same lossless message delta a
 * replayed `Last-Event-ID` gets. Explicit and unusable is a 400, never a silent default —
 * the flag-that-does-not-work rule (SPEC §3) again.
 */
function sendSnapshot(source: StreamSource, since: string | null, res: ServerResponse): void {
  const cursor = since === null ? null : Number(since);
  if (cursor !== null && (!Number.isInteger(cursor) || cursor < 0)) {
    sendJson(res, 400, {
      error: `Not a message cursor: ${JSON.stringify(since)}. since must be a non-negative integer.`,
    });
    return;
  }

  read(res, () => sendJson(res, 200, source.push(cursor).event));
}

/**
 * `GET /api/runs` (#69) — one page of the run index: the 50 most recently active summaries, or
 * the page after `?cursor=`.
 *
 * A cursor this server never minted is a **400**, its own case: the flag-that-does-not-work
 * rule (SPEC §3) in miniature — silently answering a nonsense cursor with the first page would
 * show the user a different slice of history than the one they asked for.
 */
function sendRunIndex(database: OrcaDatabase, cursor: string | null, res: ServerResponse): void {
  read(res, () => sendJson(res, 200, database.runIndex(cursor)), (error) =>
    error instanceof CursorError ? { status: 400, body: { error: error.message } } : null
  );
}

/**
 * `GET /api/report` (#70) — one page of the cross-history dispatch report: one row per retained
 * task, sorted, filtered and paged on the server.
 *
 * Every refusal it can make is a **400**, and they are all the same refusal: a query this build
 * cannot honour is not quietly replaced with one it can. A sort key it does not know, a range
 * endpoint that is not an instant, a cursor cut under a different sort — answering any of them
 * with the default first page would show the reader a slice of history they did not ask for, and
 * nothing on screen would say so (SPEC §3, the flag-that-does-not-work rule).
 */
function sendReport(database: OrcaDatabase, params: URLSearchParams, res: ServerResponse): void {
  read(
    res,
    () => sendJson(res, 200, database.report(parseReportQuery(params))),
    (error) => (error instanceof ReportQueryError ? { status: 400, body: { error: error.message } } : null)
  );
}

/**
 * **The two routes that fetch one thing by an id somebody typed** — `GET /api/run/:id`, the
 * selected-run snapshot (#69, never windowed, never truncated — ADR 0002), and `GET
 * /api/task/:id`, the two bodies and every dispatch attempt (#20).
 *
 * They are one function because they are one shape, and the shape is three answers, each of
 * them a different thing to have happened:
 *
 * - **200** — the whole of it.
 * - **404** — nothing has this id. Ids are pasted by hand and an `orchestration reset` deletes
 *   rows the rest of the file still names, so this is a *case* rather than a bug — and an empty
 *   200 would dress an id that means nothing up as a thing with nothing to say.
 * - **500** — the read itself failed.
 */
function sendById<T>(
  rawId: string,
  fetch: (id: string) => T | null,
  missing: (id: string) => string,
  res: ServerResponse
): void {
  let id: string;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    id = rawId; // A malformed escape is not an id either — it falls through to the 404.
  }

  read(res, () => {
    const found = id === '' ? null : fetch(id);
    if (found === null) sendJson(res, 404, { error: missing(id) });
    else sendJson(res, 200, found);
  });
}

/**
 * Run a read, and turn whatever it throws into an HTTP answer instead of a dead process.
 * `recognize` is how a route claims a failure of its own — a bad cursor is the client's
 * mistake (400), not the database's (500).
 */
function read(
  res: ServerResponse,
  respond: () => void,
  recognize: (error: unknown) => { status: number; body: unknown } | null = () => null
): void {
  try {
    respond();
  } catch (error) {
    const known = recognize(error);
    if (known !== null) sendJson(res, known.status, known.body);
    else sendError(res, error);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: unknown): void {
  // A stream that already pushed has already sent its 200, and there is no taking it back:
  // `writeHead` would throw ERR_HTTP_HEADERS_SENT and turn a handled failure into a crash.
  // Hanging up is all that is left to say, and `EventSource` reads it as what it is.
  if (res.headersSent) {
    res.end();
    return;
  }

  sendJson(res, 500, { error: (error as Error).message });
}

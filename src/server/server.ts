import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST, DEFAULT_POLL_INTERVAL_MS } from './cli.ts';
import type { OrcaDatabase } from './database.ts';
import { EventStream, type StreamClient } from './stream.ts';

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
 * and is the seam the server tests drive (#12). `GET /api/task/:id` (#20) will be the only
 * route that returns something else, because it is the only one that reads the bodies.
 */
export function createServer({
  database,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  clientDir = CLIENT_DIR,
}: ServerOptions): Viz {
  const stream = new EventStream(database, pollIntervalMs);

  const server = createHttpServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`).pathname;

    if (urlPath === '/api/stream') {
      openStream(stream, req, res);
      return;
    }

    if (urlPath === '/api/snapshot') {
      sendSnapshot(database, res);
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
 * The cursor a reconnecting `EventSource` replays. Absent (a first connect) or nonsense (a
 * hand-rolled client) mean the same thing: start from the top — which is a whole feed, and
 * never an error.
 */
function lastEventId(req: IncomingMessage): number {
  const header = req.headers['last-event-id'];
  const value = Number(Array.isArray(header) ? header[0] : header);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/**
 * A snapshot can throw — the database can be deleted, or Orca can checkpoint it out from
 * under a read. A 500 with the reason keeps the process up and tells the user which of
 * those it was; a thrown exception here would take the whole tool down mid-poll.
 */
function sendSnapshot(database: OrcaDatabase, res: ServerResponse): void {
  try {
    const body = JSON.stringify(database.snapshot());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  } catch (error) {
    sendError(res, error);
  }
}

function sendError(res: ServerResponse, error: unknown): void {
  // A stream that already pushed has already sent its 200, and there is no taking it back:
  // `writeHead` would throw ERR_HTTP_HEADERS_SENT and turn a handled failure into a crash.
  // Hanging up is all that is left to say, and `EventSource` reads it as what it is.
  if (res.headersSent) {
    res.end();
    return;
  }

  res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: (error as Error).message }));
}

import { createServer as createHttpServer, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_HOST } from './cli.ts';
import type { OrcaDatabase } from './database.ts';

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
  /** Where the built frontend lives. Defaults to the bundle this package ships. */
  clientDir?: string;
};

/**
 * The web server: one process, one port, serving both the JSON API and the frontend.
 *
 * `GET /api/snapshot` is the whole API at this ticket — a one-shot `StreamEvent`, which
 * makes the tool `curl`-debuggable and is the seam the server tests drive (#12). The SSE
 * stream (#17) and `GET /api/task/:id` (#20) return the same shapes through the same code.
 */
export function createServer({ database, clientDir = CLIENT_DIR }: ServerOptions): Server {
  return createHttpServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`).pathname;

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
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: (error as Error).message }));
  }
}

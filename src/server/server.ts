import { createServer as createHttpServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SPEC §6.4: one process, one port, serving the API and the frontend from dist/. */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 4269;

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
  /** Where the built frontend lives. Defaults to the bundle this package ships. */
  clientDir?: string;
};

/**
 * The web server. It serves the pre-built frontend; the JSON API and the SSE stream
 * are added by the tickets that own them (#14, #17).
 */
export function createServer({ clientDir = CLIENT_DIR }: ServerOptions = {}): Server {
  return createHttpServer((req, res) => {
    const urlPath = new URL(req.url ?? '/', `http://${req.headers.host ?? DEFAULT_HOST}`).pathname;
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

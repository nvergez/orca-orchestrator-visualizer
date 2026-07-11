import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from '../../src/server/server.ts';
import { tempDir } from '../fixtures/temp-dir.ts';

/**
 * The server is driven over real HTTP against a stand-in for the built bundle. The JSON
 * API, the SSE stream and database discovery arrive with #14 and #17; what this ticket
 * owes is a process that serves the frontend out of the package's own dist/.
 */

const clientDir = tempDir();
mkdirSync(join(clientDir, 'assets'));
writeFileSync(join(clientDir, 'index.html'), '<!doctype html><title>orca-viz</title>');
writeFileSync(join(clientDir, 'assets', 'index.js'), 'console.log("orca-viz")');

const server = createServer({ clientDir });
let origin: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('the web server', () => {
  it('serves the frontend at /', async () => {
    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('orca-viz');
  });

  it('serves the bundle assets with their real content type', async () => {
    const response = await fetch(`${origin}/assets/index.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
  });

  it('404s a path that is not in the bundle', async () => {
    expect((await fetch(`${origin}/nothing-here.js`)).status).toBe(404);
  });

  it('refuses to serve anything outside the bundle directory', async () => {
    // Encoded traversal: `..` that survives URL parsing and only decodes at the file layer.
    const response = await fetch(`${origin}/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);

    expect(response.status).toBe(403);
  });

  it('survives a malformed percent-escape rather than taking the process down', async () => {
    const response = await fetch(`${origin}/%`);

    expect(response.status).toBe(403);
    // …and the server is still up to answer the next request.
    expect((await fetch(`${origin}/`)).status).toBe(200);
  });
});

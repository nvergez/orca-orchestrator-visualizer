import type { AddressInfo } from 'node:net';
import { type DatabaseDeps, OrcaDatabase } from '../../src/server/database.ts';
import { createServer } from '../../src/server/server.ts';
import type { StreamEvent } from '../../src/shared/types.ts';
import { openStream, type SseStream } from './sse.ts';

/**
 * Seam 1 (#12): the real server, over real HTTP, against a real fixture database. No
 * driver mock, no test-only route — a test sees exactly what `curl` sees.
 */

export type Harness = {
  origin: string;
  dbPath: string;
  snapshot(): Promise<StreamEvent>;
  /** An SSE client on `/api/stream`, optionally resuming from a `Last-Event-ID` (#17). */
  stream(lastEventId?: number): Promise<SseStream>;
  close(): Promise<void>;
};

export type ServeOptions = DatabaseDeps & {
  /**
   * The poll cadence. Production is 5000 ms (SPEC §6.1), and a suite that waited that out
   * would take minutes — so the tests turn the same dial `--poll-interval` turns. The loop
   * under test is the real one; only its period is small.
   */
  pollIntervalMs?: number;
};

/** Serve a fixture database. `probe` fakes the process table so liveness is testable. */
export async function serve(dbPath: string, { pollIntervalMs = 20, ...deps }: ServeOptions = {}): Promise<Harness> {
  const database = new OrcaDatabase(dbPath, deps);
  const { server, close } = createServer({ database, pollIntervalMs, clientDir: '/nonexistent-bundle' });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const streams: SseStream[] = [];

  return {
    origin,
    dbPath,

    async snapshot() {
      const response = await fetch(`${origin}/api/snapshot`);
      if (!response.ok) throw new Error(`GET /api/snapshot → ${response.status}`);
      return (await response.json()) as StreamEvent;
    },

    async stream(lastEventId) {
      const stream = await openStream(origin, lastEventId);
      streams.push(stream);
      return stream;
    },

    async close() {
      await Promise.all(streams.map((stream) => stream.close()));
      await close();
      database.close();
    },
  };
}

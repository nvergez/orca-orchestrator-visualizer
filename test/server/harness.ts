import type { AddressInfo } from 'node:net';
import { type DatabaseDeps, OrcaDatabase } from '../../src/server/database.ts';
import { createServer } from '../../src/server/server.ts';
import type { StreamEvent } from '../../src/shared/types.ts';

/**
 * Seam 1 (#12): the real server, over real HTTP, against a real fixture database. No
 * driver mock, no test-only route — a test sees exactly what `curl` sees.
 */

export type Harness = {
  origin: string;
  dbPath: string;
  snapshot(): Promise<StreamEvent>;
  close(): Promise<void>;
};

/** Serve a fixture database. `deps` fakes the process table so liveness is testable. */
export async function serve(dbPath: string, deps: DatabaseDeps = {}): Promise<Harness> {
  const database = new OrcaDatabase(dbPath, deps);
  const server = createServer({ database, clientDir: '/nonexistent-bundle' });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    dbPath,
    async snapshot() {
      const response = await fetch(`${origin}/api/snapshot`);
      if (!response.ok) throw new Error(`GET /api/snapshot → ${response.status}`);
      return (await response.json()) as StreamEvent;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      database.close();
    },
  };
}

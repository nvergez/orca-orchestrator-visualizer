import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];

/** A scratch directory, removed when the test process exits. */
export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-viz-fixture-'));
  created.push(dir);
  return dir;
}

/**
 * A path for a fixture database, in a directory of its own — SQLite writes `-wal` and
 * `-shm` siblings, and Orca's own liveness file (`orca-runtime.json`) lives next to the
 * database, so fixtures need a directory rather than just a file.
 */
export function tempDbPath(): string {
  return join(tempDir(), 'orchestration.db');
}

process.on('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

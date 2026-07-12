import { DatabaseSync } from 'node:sqlite';
import type { StreamEvent } from '../shared/types.ts';
import { databaseMtime } from './db-files.ts';
import { StartupError } from './errors.ts';
import { type ProcessProbe, probeProcess, readLiveness } from './liveness.ts';
import { detectReset, inspectSchema, type SchemaReport } from './schema.ts';

/**
 * The read-only view of Orca's orchestration database.
 *
 * Hard invariant #1 (SPEC §1.2): **this tool never writes.** Orca's coordinator assumes it
 * is the single writer and keeps its invariants inside its own transactions, so every
 * connection this class opens is `readOnly: true` — there is no other way in, and no way
 * to ask for one.
 *
 * The connection is deliberately *not* `immutable=1`. That flag would tell SQLite the file
 * cannot change, which is a lie whenever Orca is running, and the reads would go quietly
 * corrupt (SPEC §2.2). `busy_timeout` instead: WAL readers do not block the writer, but
 * brief locks exist around checkpoint and recovery.
 */

export type DatabaseDeps = {
  /** Injected so a test can decide what is alive without forking a process. */
  probe?: ProcessProbe;
};

/** SPEC §2.2 — brief locks exist around checkpoint/recovery windows. */
export const BUSY_TIMEOUT_MS = 5000;

export class OrcaDatabase {
  /** The file this connection is reading. Reported in `meta.dbPath` and logged at boot. */
  readonly path: string;

  private readonly db: DatabaseSync;
  private readonly schema: SchemaReport;
  private readonly probe: ProcessProbe;

  constructor(path: string, { probe = probeProcess }: DatabaseDeps = {}) {
    this.path = path;
    this.probe = probe;
    this.db = openReadOnly(path);
    try {
      this.schema = inspectSchema(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** The columns this database really has — the query set every reader must build from. */
  get columns(): SchemaReport['columns'] {
    return this.schema.columns;
  }

  /**
   * The `StreamEvent` behind `GET /api/snapshot` and, from #17, every SSE push.
   *
   * The arrays are empty until #15 derives runs and tasks and #17 derives the feed. `meta`
   * is real *now*, because the failure this tool exists to prevent is showing you a
   * database that is not the one you meant — and meta is the whole of that answer.
   */
  snapshot(): StreamEvent {
    return {
      seq: this.highWaterMark(),
      meta: {
        dbPath: this.path,
        schemaVersion: this.schema.version,
        schemaSupport: this.schema.support,
        degraded: this.schema.degraded,
        // Re-derived on every call, never cached: the whole point is that it changes
        // under us when the user quits Orca (SPEC §6.1).
        ...readLiveness(this.path, this.probe),
        dbMtime: (databaseMtime(this.path) ?? new Date(0)).toISOString(),
        resetDetected: detectReset(this.db),
      },
      snapshot: { runs: [], tasks: [], coordinatorRuns: [] },
      messages: [],
    };
  }

  /**
   * `MAX(messages.sequence)` — AUTOINCREMENT, gap-free, append-only: the one cursor in
   * this schema that can be trusted (SPEC §6.1). It becomes the SSE event id in #17.
   */
  private highWaterMark(): number {
    const row = this.db.prepare('SELECT MAX(sequence) AS seq FROM messages').get() as { seq: number | null };
    return row.seq ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

function openReadOnly(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (error) {
    throw new StartupError(
      `Could not open ${path}: ${(error as Error).message}`,
      'The database must be readable, and — because reading a WAL database recreates its -shm sibling — so must the directory it sits in.'
    );
  }
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

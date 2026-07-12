import type { DatabaseSync } from 'node:sqlite';
import type { StreamEvent } from '../shared/types.ts';
import { databaseMtime } from './db-files.ts';
import { StartupError } from './errors.ts';
import { type ProcessProbe, probeProcess, readLiveness } from './liveness.ts';
import { detectReset, inspectSchema, type SchemaReport } from './schema.ts';
import { openReadOnly } from './sqlite.ts';
import { readTasks } from './tasks.ts';

/**
 * The read-only view of Orca's orchestration database.
 *
 * Hard invariant #1 (SPEC §1.2): **this tool never writes.** Every connection goes through
 * `sqlite.ts`, which is the single place that decides what a connection *is* — read-only,
 * with a busy timeout, and never `immutable`.
 */

export type DatabaseDeps = {
  /** Injected so a test can decide what is alive without forking a process. */
  probe?: ProcessProbe;
};

export class OrcaDatabase {
  /** The file this connection is reading. Reported in `meta.dbPath` and logged at boot. */
  readonly path: string;

  private readonly db: DatabaseSync;
  private readonly schema: SchemaReport;
  private readonly probe: ProcessProbe;

  constructor(path: string, { probe = probeProcess }: DatabaseDeps = {}) {
    this.path = path;
    this.probe = probe;
    this.db = open(path);
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
   * `tasks` is the whole database as one graph — no run scoping, which is #16's job and is
   * the reason 76 tasks currently render as a soup. `runs` and `coordinatorRuns` wait for
   * #16, and `messages` for #17; an empty array is the honest thing to send until then.
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
      snapshot: { runs: [], tasks: readTasks(this.db, this.schema.columns), coordinatorRuns: [] },
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

/** Same connection as everywhere else; the failure is fatal *here*, so it is worded for a user. */
function open(path: string): DatabaseSync {
  try {
    return openReadOnly(path);
  } catch (error) {
    throw new StartupError(
      `Could not open ${path}: ${(error as Error).message}`,
      'The database must be readable, and — because reading a WAL database recreates its -shm sibling — so must the directory it sits in.'
    );
  }
}

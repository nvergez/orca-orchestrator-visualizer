import type { DatabaseSync } from 'node:sqlite';
import type { Liveness, StreamEvent } from '../shared/types.ts';
import { buildAttribution } from './attribution.ts';
import { readCoordinatorRuns } from './coordinator-runs.ts';
import { databaseMtime } from './db-files.ts';
import { StartupError } from './errors.ts';
import { type ProcessProbe, probeProcess, readLiveness } from './liveness.ts';
import { readMessages } from './messages.ts';
import { inferRuns } from './runs.ts';
import { detectReset, hasColumn, inspectSchema, MESSAGE_SEQUENCE, type SchemaReport } from './schema.ts';
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
   * The `StreamEvent` behind `GET /api/snapshot` and every SSE push — first connect, normal
   * tick and reconnect alike. One event type, one code path, no resync mode (SPEC §6.2).
   *
   * The order here is the one thing worth reading twice: **liveness is decided before the
   * runs are**. A run is live only if Orca itself is (SPEC §7.3) — the task rows still read
   * `dispatched` for an orchestration that was killed mid-flight, and nothing will ever
   * rewrite them, so a green dot derived from the rows alone would be this tool's worst lie.
   *
   * `since` is the client's last-seen `messages.sequence`. The graph comes whole every time
   * (it is overwritten in place, so a delta would have to be reconstructed and could drift);
   * the messages come as the delta after that cursor, because they are append-only and a
   * delta is therefore both cheap and *correct* (SPEC §6.3). 0 — a first connect, or a
   * `curl` of `/api/snapshot` — means the whole feed.
   */
  snapshot(since = 0): StreamEvent {
    const liveness = readLiveness(this.path, this.probe);
    const entries = readTasks(this.db, this.schema.columns);
    const { runs, tasks } = inferRuns(entries, {
      orcaIsLive: liveness.liveness === 'live',
    });

    // Where each message belongs (SPEC §4.4), built from what the run inference has just
    // worked out — the run each task landed in, and every terminal that ever held one. The
    // messages are then read against it, so nothing downstream re-derives the grouping.
    const attribution = buildAttribution(
      runs,
      tasks,
      new Map(entries.map((entry) => [entry.task.id, entry.assignees]))
    );

    return {
      seq: this.highWaterMark(),
      meta: {
        dbPath: this.path,
        schemaVersion: this.schema.version,
        schemaSupport: this.schema.support,
        degraded: this.schema.degraded,
        // Re-derived on every call, never cached: the whole point is that it changes
        // under us when the user quits Orca (SPEC §6.1).
        ...liveness,
        dbMtime: (databaseMtime(this.path) ?? new Date(0)).toISOString(),
        resetDetected: detectReset(this.db, this.schema.columns),
      },
      snapshot: {
        runs,
        tasks,
        // Empty in practice, and nothing above depends on it (SPEC §4.2, trap 3).
        coordinatorRuns: readCoordinatorRuns(this.db, this.schema.columns),
      },
      messages: readMessages(this.db, this.schema.columns, { since, attribution }),
    };
  }

  /**
   * **The change detector** (SPEC §6.1): SQLite's own counter of commits made by *other*
   * connections — which is every commit, since this tool never writes. Unchanged since the
   * last tick means nothing in the file moved, and the poll loop skips everything.
   *
   * It is not the cursor. An in-place `ready → dispatched` flip moves this and leaves
   * `MAX(messages.sequence)` exactly where it was; a new message moves both.
   *
   * It needs no column guard (#21): a pragma is not a column, so it survives any drift the
   * rest of this class degrades around — which is what lets the DAG go on updating live on an
   * Orca whose `messages` table this build cannot read at all.
   */
  dataVersion(): number {
    const row = this.db.prepare('PRAGMA data_version').get() as { data_version: number };
    return row.data_version;
  }

  /**
   * **The other thing that changes without the database changing** (SPEC §6.1): whether Orca
   * is still running.
   *
   * It is re-read every tick, beside `data_version`, because quitting Orca is precisely the
   * event that *cannot* announce itself in the file — the process that writes the file is the
   * one that just died, so `data_version` freezes exactly when the badge most needs to move.
   * A green "connected to running Orca" dot left on screen over a dead Orca is the one lie
   * this tool must never tell (SPEC §7.3).
   *
   * It is not a query: a small file read and a signal-0 against the process table. An idle
   * tick stays ~free, which is the whole promise of the gate.
   */
  liveness(): Liveness {
    return readLiveness(this.path, this.probe).liveness;
  }

  /**
   * **The cursor** (SPEC §6.1): `MAX(messages.sequence)` — AUTOINCREMENT, gap-free,
   * append-only, the one value in this schema that can be resumed from. It is also the SSE
   * event id, which is what makes a browser's automatic `Last-Event-ID` replay land exactly
   * on it with no code of ours in between.
   *
   * Guarded on the column really being there, like every other read in this server (#21).
   * An Orca that renamed `sequence` — or dropped `messages`, which introspects to the same
   * empty column set — costs the feed and the reset detector, and it must not cost the DAG:
   * asking SQLite for a column it does not have throws, and that would be a hard-fail this
   * tool has no right to (SPEC §5 — the DAG core is the only one).
   *
   * So the cursor degrades to 0, and the stream degrades with it *coherently*: every event id
   * is 0, every `Last-Event-ID` resumes from 0, and `readMessages` — guarded on the same
   * column — returns nothing to resume. A feed that cannot be read is an empty feed, not a
   * broken stream: the graph still ticks (`dataVersion` needs no column), and the user is told
   * which feature went missing in `meta.degraded`.
   */
  private highWaterMark(): number {
    if (!hasColumn(this.schema.columns, MESSAGE_SEQUENCE)) return 0;

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

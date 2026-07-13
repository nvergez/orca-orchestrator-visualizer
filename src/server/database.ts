import type { DatabaseSync } from 'node:sqlite';
import type { Liveness, Run, StreamEvent, Task, TaskDetail } from '../shared/types.ts';
import { type Attribution, buildAttribution } from './attribution.ts';
import { conversationOf } from './conversation.ts';
import { readCoordinatorRuns } from './coordinator-runs.ts';
import { databaseMtime } from './db-files.ts';
import { StartupError } from './errors.ts';
import { attachGates, readGates } from './gates.ts';
import { type LivenessReport, type ProcessProbe, probeProcess, readLiveness } from './liveness.ts';
import { detectHistoryLoss } from './history-loss.ts';
import { readMessages } from './messages.ts';
import { inferRuns, type TaskWithHandle } from './runs.ts';
import { inspectSchema, type SchemaReport } from './schema.ts';
import { openReadOnly } from './sqlite.ts';
import { readTaskDetail } from './task-detail.ts';
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
  /**
   * The snapshot's wall clock, injected so a test can hold it still. It feeds exactly one
   * thing: the deprecated `live` projection (SPEC §12.4). Health is the client's derivation,
   * against the client's own clock — never computed here (SPEC §12.3).
   */
  now?: () => number;
  /**
   * A synchronization point after the message rows have been materialized. Tests use it to
   * commit through a real second connection at the concurrency boundary; production leaves it
   * unset. It observes the read without replacing the database driver or any query result.
   */
  afterMessagesRead?: () => void;
};

export class OrcaDatabase {
  /** The file this connection is reading. Reported in `meta.dbPath` and logged at boot. */
  readonly path: string;

  private readonly db: DatabaseSync;
  private readonly schema: SchemaReport;
  private readonly probe: ProcessProbe;
  private readonly now: () => number;
  private readonly afterMessagesRead: () => void;

  constructor(
    path: string,
    { probe = probeProcess, now = Date.now, afterMessagesRead = () => {} }: DatabaseDeps = {}
  ) {
    this.path = path;
    this.probe = probe;
    this.now = now;
    this.afterMessagesRead = afterMessagesRead;
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
    const { liveness, entries, runs, tasks, attribution } = this.derive();

    // The gates, from the `decision_gate` *messages* that raise them, enriched by the
    // authoritative `decision_gates` rows their Coordinator twins keep (SPEC §4.2, trap 1;
    // §4.5, #45). They are placed by the same attribution the conversation uses — a gate is a
    // message, and it is placed like one — then given their present blocking effect from the
    // tasks' current state and hung back on the runs they block (`hasBlockingGates`) and the
    // nodes they mark.
    //
    // They are read *here* rather than in `derive()` because they are the snapshot's alone: a
    // task detail already has its gates (they were in the snapshot the client is holding), and
    // making a node click scan `messages` twice over for them would be work done to be discarded.
    const gated = attachGates(runs, tasks, readGates(this.db, this.schema.columns, attribution));

    // **Every** message, once — and then used twice, which is the only way to read them once.
    //
    // The conversation is a whole thing or it is a fragment, so it needs the log entire; the
    // client's cursor wants only what it has not seen. Reading the table twice would answer both
    // and disagree with itself the moment Orca wrote a row between the two reads.
    const messages = readMessages(this.db, this.schema.columns, { since: 0, attribution });
    // The cursor belongs to exactly these rows. A commit after this read stays above `seq`, so a
    // subscriber cannot skip the new row behind an event id that did not carry it (#49).
    const seq = messages.at(-1)?.sequence ?? 0;
    this.afterMessagesRead();

    return {
      seq,
      meta: {
        dbPath: this.path,
        schemaVersion: this.schema.version,
        schemaSupport: this.schema.support,
        degraded: this.schema.degraded,
        // Re-derived on every call, never cached: the whole point is that it changes
        // under us when the user quits Orca (SPEC §6.1).
        ...liveness,
        dbMtime: (databaseMtime(this.path) ?? new Date(0)).toISOString(),
        historyLoss: detectHistoryLoss(this.db, this.schema.columns),
      },
      snapshot: {
        runs: gated.runs,
        tasks: gated.tasks,
        gates: gated.gates,
        // The four-source merge (SPEC §4.7) — the orchestrator's prompts out of `tasks.spec`, the
        // agents' replies out of `messages`, a gate and the answer threaded on it, and the final
        // report out of `tasks.result`. It is the whole of what this screen is for, and the client
        // does nothing to it but choose a scope.
        turns: conversationOf({ entries, runs: gated.runs, gates: gated.gates, messages }),
        // Empty in practice, and nothing above depends on it (SPEC §4.2, trap 3).
        coordinatorRuns: readCoordinatorRuns(this.db, this.schema.columns),
      },
      // The delta the client's cursor asked for. What it is still *for*, now that the conversation
      // is not built out of it, is the one thing a snapshot cannot say — what just arrived — which
      // is what flashes a node (SPEC §7.6).
      messages: messages.filter((message) => message.sequence > since),
    };
  }

  /**
   * **What a node click fetches** (#20): the bodies the snapshot leaves in the file, and every
   * dispatch attempt the snapshot folded down to one. Null when no such task exists — a 404,
   * because an id that names nothing is not a task with nothing to say (`task-detail.ts`).
   *
   * It no longer runs the snapshot's derivation. It used to, because it carried the task's
   * messages and they had to be placed by the same rules the conversation places them by — and that whole
   * list is now on the wire already, as the task-scoped slice of `snapshot.turns`, with both sides
   * of the exchange in it rather than one. What is left here is what only a fetch can give: the
   * two bodies, in full.
   */
  taskDetail(id: string): TaskDetail | null {
    return readTaskDetail(this.db, this.schema.columns, id);
  }

  /**
   * The runs, the tasks, and where a message belongs — everything the snapshot needs, and nothing
   * it would throw away.
   *
   * The one thing worth reading twice is that **liveness is decided before the runs are**. A run
   * is live only if Orca itself is (SPEC §7.3): the task rows still read `dispatched` for an
   * orchestration that was killed mid-flight, and nothing will ever rewrite them, so a green dot
   * derived from the rows alone would be this tool's worst lie.
   *
   * Then the attribution (SPEC §4.4), built from what the run inference has just worked out — the
   * run each task landed in, and every terminal that ever held one. That handle set is the **cast**
   * (`cast.ts`) seen from the other side, which is why both are built out of the same attempts:
   * "who worked for this orchestrator" and "whose messages belong to it" are one question.
   */
  private derive(): {
    liveness: LivenessReport;
    /** The tasks, plus the handle, the attempts and the body previews the wire does not carry. */
    entries: TaskWithHandle[];
    runs: Run[];
    tasks: Task[];
    attribution: Attribution;
  } {
    const liveness = readLiveness(this.path, this.probe);
    const read = readTasks(this.db, this.schema.columns);
    const { runs, tasks } = inferRuns(read, {
      orcaIsLive: liveness.liveness === 'live',
      now: this.now(),
    });

    // A run is not a column, so it only lands on a task once the inference has run — and the
    // conversation needs it *together with* the spec, the result and the attempts, which are
    // precisely the things the wire contract keeps off a task. So the entries are re-joined to the
    // tasks that now know their run, rather than the run being smuggled back onto the entry.
    const placed = new Map(tasks.map((task) => [task.id, task]));
    const entries = read.map((entry) => ({ ...entry, task: placed.get(entry.task.id)! }));

    const attribution = buildAttribution(
      runs,
      tasks,
      new Map(entries.map((entry) => [entry.task.id, assigneesOf(entry)]))
    );

    return { liveness, entries, runs, tasks, attribution };
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

  close(): void {
    this.db.close();
  }
}

/**
 * Every terminal that ever held this task, oldest attempt first, deduplicated.
 *
 * Not the latest attempt's assignee: a retry is dispatched to a *fresh* worktree with a fresh
 * handle, so the first worker's handle exists nowhere else — and its messages are exactly the ones
 * a post-mortem came for. The same list is what `cast.ts` names A1, A2, A3, from the other side of
 * the same question.
 */
function assigneesOf(entry: TaskWithHandle): string[] {
  const handles: string[] = [];

  for (const attempt of entry.attempts) {
    if (attempt.assigneeHandle !== '' && !handles.includes(attempt.assigneeHandle)) {
      handles.push(attempt.assigneeHandle);
    }
  }

  return handles;
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

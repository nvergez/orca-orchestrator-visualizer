import type { DatabaseSync } from 'node:sqlite';
import { mergeReceipts, receiptOfWorkerDone } from '../shared/receipt.ts';
import type {
  FeedMessage,
  Liveness,
  Meta,
  ReceiptFact,
  ReportPage,
  Run,
  RunIndexPage,
  RunSnapshot,
  StreamEvent,
  Task,
  TaskDetail,
} from '../shared/types.ts';
import { type Attribution, buildAttribution } from './attribution.ts';
import { conversationOf } from './conversation.ts';
import { readCoordinatorRuns } from './coordinator-runs.ts';
import { databaseMtime } from './db-files.ts';
import { digestRuns } from './digests.ts';
import { StartupError } from './errors.ts';
import { attachGates, readGates } from './gates.ts';
import { detectHistoryLoss } from './history-loss.ts';
import { pageRuns, type RunEvidence, snapshotRun } from './history.ts';
import { type LivenessReport, type ProcessProbe, probeProcess, readLiveness } from './liveness.ts';
import { readMessages } from './messages.ts';
import { buildReport, type ReportQuery } from './report.ts';
import { inferRuns, type TaskWithHandle } from './runs.ts';
import { inspectSchema, type SchemaReport } from './schema.ts';
import { openReadOnly } from './sqlite.ts';
import type { PushResult } from './stream.ts';
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
   */
  snapshot(since: number | null = null): StreamEvent {
    return this.push(since).event;
  }

  /**
   * One event, plus one fingerprint per run over the evidence its selected-run snapshot serves
   * (`digests.ts`). The stream diffs two of those maps to fill `affected` on a tick — which is
   * how a push *names* the runs a change touched instead of carrying the whole of history (#69).
   *
   * The event's own `affected` says `all`: this method backs the first connect, the reconnect
   * and `/api/snapshot`, and for all three the honest claim is "your whole view may be stale".
   * Only the poll loop knows a client's previous view, so only it narrows the claim (`stream.ts`).
   *
   * `since` is the client's last-seen `messages.sequence`, and the messages are the lossless
   * delta after it — append-only rows, so a delta is both cheap and *correct* (SPEC §6.3).
   * **Null — a first connect — means no delta at all**: a client that has seen nothing has
   * missed nothing, and the history behind the cursor is the paged endpoints' to serve, not
   * this event's to backfill. (A replayed `Last-Event-ID: 0` still means "everything after 0":
   * losslessness is owed to a cursor, however small.)
   */
  push(since: number | null = null): PushResult {
    const { liveness, evidence, messages, seq } = this.readEvidence();

    const event: StreamEvent = {
      seq,
      meta: this.metaOf(liveness),
      affected: { all: true, runIds: [], unplaced: false },
      // What the delta is still *for* is the one thing a snapshot cannot say — what just
      // arrived — which is what flashes a node (SPEC §7.6).
      messages: since === null ? [] : messages.filter((message) => message.sequence > since),
    };

    return { event, digests: digestRuns(evidence), handles: handlesOf(evidence.runs) };
  }

  /**
   * One page of the **run index** — `GET /api/runs` (#69). The 50 most recently active
   * summaries, or the page an opaque cursor asks for; `CursorError` (a 400, not a 500) when the
   * cursor is not one this server minted.
   */
  runIndex(cursor: string | null): RunIndexPage {
    const { liveness, evidence } = this.readEvidence();
    const page = pageRuns(evidence.runs, cursor);

    return {
      meta: this.metaOf(liveness),
      runs: page.runs,
      nextCursor: page.nextCursor,
      coordinatorRuns: evidence.coordinatorRuns,
    };
  }

  /**
   * The **selected-run snapshot** — `GET /api/run/:id` (#69): one run's complete retained
   * evidence, never windowed, never truncated (ADR 0002). Null when no run has this id — a
   * 404, because an id that names nothing is not a run with nothing to say.
   */
  runSnapshot(id: string): RunSnapshot | null {
    const { liveness, evidence } = this.readEvidence();
    const snapshot = snapshotRun(evidence, id);

    return snapshot === null ? null : { meta: this.metaOf(liveness), ...snapshot };
  }

  /**
   * One page of the **cross-history dispatch report** — `GET /api/report` (#70): one row per
   * retained task across every run, sorted, filtered and paged here rather than in a browser
   * that would have to hold the whole of history to do it.
   *
   * It is a fourth projection of the same evidence pass, and it reads nothing the other three do
   * not: no second task-detail truth, and — deliberately — no graph (SPEC §12.6).
   */
  report(query: ReportQuery): ReportPage {
    const { liveness, evidence } = this.readEvidence();

    return { meta: this.metaOf(liveness), ...buildReport(evidence, query) };
  }

  /**
   * Everything one read of the database derives, exactly once — the projections above (the
   * stream event, the run index, the selected-run snapshot, the report, the digests) all draw
   * from this one pass, which is what keeps them incapable of disagreeing about what a run holds.
   */
  private readEvidence(): {
    liveness: LivenessReport;
    evidence: RunEvidence;
    messages: FeedMessage[];
    /** The cursor these very rows carry — read off them, never asked of the database again (#49). */
    seq: number;
  } {
    const { liveness, entries, runs, tasks, attribution } = this.derive();

    // The gates, from the `decision_gate` *messages* that raise them, enriched by the
    // authoritative `decision_gates` rows their Coordinator twins keep (SPEC §4.2, trap 1;
    // §4.5, #45). They are placed by the same attribution the conversation uses — a gate is a
    // message, and it is placed like one — then given their present blocking effect from the
    // tasks' current state and hung back on the runs they block (`hasBlockingGates`) and the
    // nodes they mark.
    //
    // `attachGates` is what derives that blocking effect, so it is `gated.gates` — never the raw
    // `readGates` list — that every projection below serves. A gate on the wire without its
    // present blocking fact is exactly the stale-probe lie #45 was filed about.
    const gated = attachGates(runs, tasks, readGates(this.db, this.schema.columns, attribution));

    // **Every** message, once — and then used twice, which is the only way to read them once.
    //
    // The conversation is a whole thing or it is a fragment, so it needs the log entire; the
    // client's cursor wants only what it has not seen. Reading the table twice would answer both
    // and disagree with itself the moment Orca wrote a row between the two reads.
    const messages = readMessages(this.db, this.schema.columns, { since: 0, attribution });
    // The cursor belongs to exactly these rows, and is read *off* them rather than asked of the
    // database a second time (#49). A `MAX(sequence)` query here would race the read above: a
    // commit landing between the two would advertise a cursor covering a row this event does not
    // carry, and the subscriber would resume past it and never see it. Deriving it from the rows
    // in hand makes that unrepresentable — a later commit simply stays above `seq`.
    //
    // It degrades to 0 exactly when the feed does. `readMessages` is guarded on
    // `messages.sequence` (#21) and returns nothing without it, so an Orca whose message table
    // this build cannot read yields cursor 0, event id 0, and every `Last-Event-ID` replay
    // resuming from 0 — a feed that cannot be read is an empty feed, not a broken stream. The
    // graph ticks on regardless (`dataVersion` needs no column), and `meta.degraded` names what
    // went missing.
    const seq = messages.at(-1)?.sequence ?? 0;
    this.afterMessagesRead();

    /** Memoized behind the getter below: merged at most once per read, and only if asked for. */
    let receipts: Map<string, ReceiptFact[]> | undefined;

    return {
      liveness,
      evidence: {
        runs: gated.runs,
        tasks: gated.tasks,
        // Oldest attempt first, as `tasks.ts` reads them — the selected-run snapshot's
        // append-only retry record (SPEC §12), and the same rows the cast was built from.
        attemptsByTask: new Map(entries.map((entry) => [entry.task.id, entry.attempts])),
        gates: gated.gates,
        // The four-source merge (SPEC §4.7) — the orchestrator's prompts out of `tasks.spec`, the
        // agents' replies out of `messages`, a gate and the answer threaded on it, and the final
        // report out of `tasks.result`. It is the whole of what this screen is for, and the client
        // does nothing to it but choose a scope.
        turns: conversationOf({ entries, runs: gated.runs, gates: gated.gates, messages }),
        // Empty in practice, and nothing above depends on it (SPEC §4.2, trap 3).
        coordinatorRuns: readCoordinatorRuns(this.db, this.schema.columns),
        // The recognized outcome facts of both evidence columns, per task (#67) — what the
        // report's compact summary is a cap of, and the inspector's receipt is the whole of.
        //
        // **Merged on first read, and only the report ever reads it** (#70). Every other
        // projection of this evidence — the stream event, the run index, the selected-run
        // snapshot, the digests — runs on the poll loop, five seconds apart, for ever; a machine-
        // wide receipt merge they would all pay for and none of them would look at is exactly the
        // per-tick cost §12.1 says these features must not add.
        get receiptsByTask() {
          return (receipts ??= receiptsOf(entries, messages));
        },
      },
      messages,
      seq,
    };
  }

  /** The header every payload carries. Re-derived on every call, never cached (SPEC §6.1). */
  private metaOf(liveness: LivenessReport): Meta {
    return {
      dbPath: this.path,
      schemaVersion: this.schema.version,
      schemaSupport: this.schema.support,
      degraded: this.schema.degraded,
      // Re-derived on every call, never cached: the whole point is that it changes under us
      // when the user quits Orca (SPEC §6.1).
      ...liveness,
      dbMtime: (databaseMtime(this.path) ?? new Date(0)).toISOString(),
      historyLoss: detectHistoryLoss(this.db, this.schema.columns),
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
 * The whole outcome receipt of every task that has one (#67) — merged **once**, for the report
 * that asks it of every task at once (#70).
 *
 * It is the inspector's reading, exactly (`task-detail.ts`): `tasks.result` merged with every
 * `worker_done` payload that named the task, agreement deduplicating into one fact with two
 * provenances and conflict staying two facts. The two have to *be* one reading — a row that
 * summarized an outcome the panel behind it does not show would be the report inventing a second
 * truth about a task, which is the one thing #70 is not allowed to do.
 *
 * Everything it reads is already in hand: the result column was recognized as the tasks were read
 * (`tasks.ts`), and the payloads were parsed as the messages were (`readMessages`). So it is a
 * pass over rows, never a second query — and never the per-task scan of the log that a merge done
 * inside the row loop would be (O(tasks × messages)).
 */
function receiptsOf(entries: TaskWithHandle[], messages: FeedMessage[]): Map<string, ReceiptFact[]> {
  const completions = new Map<string, unknown[]>();

  for (const message of messages) {
    // `taskId` is the attribution the rest of the server already made (SPEC §4.4): a payload that
    // names no task that still exists names no task, and is not guessed into one here.
    if (message.type !== 'worker_done' || message.taskId === null) continue;
    const held = completions.get(message.taskId);
    if (held) held.push(message.payload);
    else completions.set(message.taskId, [message.payload]);
  }

  const receipts = new Map<string, ReceiptFact[]>();

  for (const entry of entries) {
    const done = completions.get(entry.task.id) ?? [];
    const facts = mergeReceipts(entry.resultReceipt, ...done.map((payload) => receiptOfWorkerDone(payload)));
    if (facts.length > 0) receipts.set(entry.task.id, facts);
  }

  return receipts;
}

/**
 * Every terminal the retained runs name: each orchestrator, and every agent it ever dispatched.
 *
 * The enrichment decorator's exact join key (#61, `enrichment.ts`) — built here, off the runs
 * this read already derived, because the runs themselves stopped travelling on the event when
 * #69 took the full history off the wire.
 */
function handlesOf(runs: Run[]): string[] {
  const handles: string[] = [];

  for (const run of runs) {
    if (run.handle !== null) handles.push(run.handle);
    for (const member of run.cast) handles.push(member.handle);
  }

  return handles;
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

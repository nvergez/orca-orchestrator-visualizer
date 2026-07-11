import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { columnsOf, schemaSql, type SchemaOptions, TABLES, type TableName } from './schema.ts';

/**
 * Builds a real `orchestration.db` on disk, row by row.
 *
 * Its job is to reproduce the *shape* of the live database, never its contents — the
 * repo is public and `spec`, `body` and `payload` hold whatever the user and their
 * agents actually typed. So: a SQL builder, never a committed dump.
 *
 * Two things it deliberately owns, because a caller would get them wrong:
 *
 * 1. **The timestamp split** (SPEC §4.2 trap 5). Columns Orca writes from SQL hold
 *    `'YYYY-MM-DD HH:MM:SS'` UTC; the two columns it writes from JS — `tasks.completed_at`
 *    and `coordinator_runs.completed_at` — hold ISO-8601. Callers pass a `Date`; the
 *    builder writes whichever format that column really carries.
 * 2. **Column presence.** A row is a record keyed by real column names, filtered at write
 *    time against the columns that exist at the fixture's schema version — so a task
 *    given a handle in a v3 fixture genuinely loses it, exactly as an older Orca would.
 *
 * Nothing else is defaulted away: gates, orphaned task ids and retry rows are things a
 * test asks for explicitly, because they are the point.
 */

/** What SQLite will take in a bound parameter. */
type SqlValue = string | number | null;
type Row = Record<string, SqlValue>;

/** `'2026-07-08 12:32:13'` — every column Orca writes with `datetime('now')`. */
function sqlTime(at: Date): string {
  return at.toISOString().slice(0, 19).replace('T', ' ');
}

/** `'2026-07-08T12:38:28.374Z'` — the two columns Orca writes from JS. */
function isoTime(at: Date): string {
  return at.toISOString();
}

/**
 * Deterministic ids, so a fixture built twice is the same fixture. Exported because a
 * fixture has to *reference* ids it has not inserted yet — a task's `deps`, a message's
 * `payload.taskId`, the gate message a reply threads on.
 */
export function syntheticId(prefix: 'task' | 'ctx' | 'msg' | 'gate' | 'run', seed: string): string {
  return `${prefix}_${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`;
}

/** Orca's terminal handles are `term_<uuid>`; a fixture's are derived, not random. */
export function handleFor(seed: string): string {
  const hex = createHash('sha256').update(`handle:${seed}`).digest('hex');
  const parts = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)];
  return `term_${parts.join('-')}`;
}

export type TaskInput = {
  id?: string;
  parentId?: string | null;
  /** `created_by_terminal_handle` — the run key (SPEC §4.3). NULL for 4 of 76 live tasks. */
  handle?: string | null;
  title?: string | null;
  displayName?: string | null;
  spec?: string;
  /** Unknown values need `allowUnknownEnums` — see `SchemaOptions`. */
  status?: string;
  /** The DAG edges: the ids this task depends on. */
  deps?: string[];
  result?: string | null;
  createdAt: Date;
  completedAt?: Date | null;
};

export type DispatchInput = {
  id?: string;
  taskId: string;
  assigneeHandle?: string | null;
  status?: string;
  failureCount?: number;
  lastFailure?: Date | null;
  dispatchedAt?: Date | null;
  completedAt?: Date | null;
  createdAt?: Date;
  lastHeartbeatAt?: Date | null;
};

export type MessageInput = {
  id?: string;
  fromHandle: string;
  toHandle: string;
  subject: string;
  body?: string;
  type?: string;
  priority?: string;
  /** A gate's replies thread on the gate message's `id` (SPEC §4.5). */
  threadId?: string | null;
  /** Serialized to the `payload` TEXT column. `payload.taskId` carries 83% of attribution. */
  payload?: unknown;
  read?: boolean;
  /**
   * `sequence` is AUTOINCREMENT and normally left to SQLite. Set it explicitly to open the
   * `sqlite_sequence` gap an `orchestration reset` leaves behind (SPEC §5, reset detector).
   */
  sequence?: number;
  createdAt: Date;
  deliveredAt?: Date | null;
};

/** A `decision_gates` row. The live database has **zero** of these — see SPEC §4.2 trap 1. */
export type GateInput = {
  id?: string;
  taskId: string;
  question: string;
  options?: string[];
  status?: string;
  resolution?: string | null;
  createdAt: Date;
  resolvedAt?: Date | null;
};

/** A `coordinator_runs` row. Also empty in practice — SPEC §4.2 trap 3. */
export type CoordinatorRunInput = {
  id?: string;
  spec: string;
  status?: string;
  coordinatorHandle: string;
  pollIntervalMs?: number;
  createdAt: Date;
  completedAt?: Date | null;
};

export class FixtureBuilder {
  private readonly rows: Record<TableName, Row[]> = {
    tasks: [],
    dispatch_contexts: [],
    messages: [],
    decision_gates: [],
    coordinator_runs: [],
  };

  private readonly schema: SchemaOptions;

  constructor(schema: SchemaOptions = {}) {
    this.schema = schema;
  }

  task(input: TaskInput): this {
    const id = input.id ?? syntheticId('task', `task:${this.rows.tasks.length}`);
    this.rows.tasks.push({
      id,
      parent_id: input.parentId ?? null,
      created_by_terminal_handle: input.handle ?? null,
      task_title: input.title ?? null,
      display_name: input.displayName ?? null,
      spec: input.spec ?? `synthetic spec for ${id}`,
      status: input.status ?? 'pending',
      deps: JSON.stringify(input.deps ?? []),
      result: input.result ?? null,
      created_at: sqlTime(input.createdAt),
      // The one ISO column on this table (trap 5).
      completed_at: input.completedAt ? isoTime(input.completedAt) : null,
    });
    return this;
  }

  /** One row per dispatch *attempt* — several rows for one task is the retry story. */
  dispatch(input: DispatchInput): this {
    const id = input.id ?? syntheticId('ctx', `ctx:${this.rows.dispatch_contexts.length}`);
    this.rows.dispatch_contexts.push({
      id,
      task_id: input.taskId,
      assignee_handle: input.assigneeHandle ?? null,
      status: input.status ?? 'pending',
      failure_count: input.failureCount ?? 0,
      last_failure: input.lastFailure ? sqlTime(input.lastFailure) : null,
      dispatched_at: input.dispatchedAt ? sqlTime(input.dispatchedAt) : null,
      completed_at: input.completedAt ? sqlTime(input.completedAt) : null,
      created_at: sqlTime(input.createdAt ?? input.dispatchedAt ?? new Date(0)),
      last_heartbeat_at: input.lastHeartbeatAt ? sqlTime(input.lastHeartbeatAt) : null,
    });
    return this;
  }

  message(input: MessageInput): this {
    const id = input.id ?? syntheticId('msg', `msg:${this.rows.messages.length}`);
    const row: Row = {
      id,
      from_handle: input.fromHandle,
      to_handle: input.toHandle,
      subject: input.subject,
      body: input.body ?? '',
      type: input.type ?? 'status',
      priority: input.priority ?? 'normal',
      thread_id: input.threadId ?? null,
      payload: input.payload === undefined ? null : JSON.stringify(input.payload),
      read: input.read ? 1 : 0,
      created_at: sqlTime(input.createdAt),
      delivered_at: input.deliveredAt ? sqlTime(input.deliveredAt) : null,
    };
    if (input.sequence !== undefined) row.sequence = input.sequence;
    this.rows.messages.push(row);
    return this;
  }

  gate(input: GateInput): this {
    const id = input.id ?? syntheticId('gate', `gate:${this.rows.decision_gates.length}`);
    this.rows.decision_gates.push({
      id,
      task_id: input.taskId,
      question: input.question,
      options: JSON.stringify(input.options ?? []),
      status: input.status ?? 'pending',
      resolution: input.resolution ?? null,
      created_at: sqlTime(input.createdAt),
      resolved_at: input.resolvedAt ? sqlTime(input.resolvedAt) : null,
    });
    return this;
  }

  coordinatorRun(input: CoordinatorRunInput): this {
    const id = input.id ?? syntheticId('run', `run:${this.rows.coordinator_runs.length}`);
    this.rows.coordinator_runs.push({
      id,
      spec: input.spec,
      status: input.status ?? 'idle',
      coordinator_handle: input.coordinatorHandle,
      poll_interval_ms: input.pollIntervalMs ?? 2000,
      created_at: sqlTime(input.createdAt),
      // The other ISO column (trap 5).
      completed_at: input.completedAt ? isoTime(input.completedAt) : null,
    });
    return this;
  }

  /** Write the database to `path`, in WAL mode as Orca keeps it. Returns `path`. */
  write(path: string): string {
    const db = new DatabaseSync(path);
    try {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(schemaSql(this.schema));

      db.exec('BEGIN');
      for (const table of TABLES) {
        const present = columnsOf(table, this.schema);
        for (const row of this.rows[table]) {
          // A column absent at this schema version drops out of the insert entirely —
          // that is what "the column is genuinely not there" has to mean.
          const columns = present.filter((column) => column in row);
          const statement = db.prepare(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
          );
          statement.run(...columns.map((column) => row[column] ?? null));
        }
      }
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    return path;
  }
}

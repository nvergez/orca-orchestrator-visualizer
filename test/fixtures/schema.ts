/**
 * Orca's orchestration schema, as a SQL builder.
 *
 * The DDL below is transcribed from a live `orchestration.db` at `user_version = 5`
 * (`SELECT sql FROM sqlite_master`), which is the schema HANDOFF.md pins as current.
 * It is generated rather than dumped so fixtures can express the *drift* the tool has
 * to survive — older versions with columns genuinely absent, newer ones with enum
 * values we have never heard of. A committed binary can express none of that.
 *
 * Orca's migration history is purely additive (SPEC §5), so a version is exactly a set
 * of columns: each column below records the schema version that introduced it, and a
 * fixture at version N gets every column introduced at or before N.
 */

/** The current schema version (Orca's `SCHEMA_VERSION`). */
export const CURRENT_SCHEMA_VERSION = 5;

/** Columns Orca added after v1, with the version that added each (SPEC §5). */
const COLUMN_ADDED_AT: Record<string, number> = {
  'dispatch_contexts.last_heartbeat_at': 2,
  'messages.delivered_at': 3,
  'tasks.created_by_terminal_handle': 4,
  'tasks.task_title': 5,
  'tasks.display_name': 5,
};

const TASK_STATUSES = ['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked'];
const DISPATCH_STATUSES = ['pending', 'dispatched', 'completed', 'failed', 'circuit_broken'];
const MESSAGE_TYPES = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'heartbeat',
];
const MESSAGE_PRIORITIES = ['normal', 'high', 'urgent'];
const GATE_STATUSES = ['pending', 'resolved', 'timeout'];
const COORDINATOR_STATUSES = ['idle', 'running', 'completed', 'failed'];

export type SchemaOptions = {
  /** `PRAGMA user_version`. Defaults to the current version. */
  userVersion?: number;
  /**
   * Drop the enum CHECK constraints, so a fixture can hold a task status or message
   * type this tool has never heard of. A real database can only contain such a value if
   * its schema permits it, which is what a newer Orca that widened an enum would look
   * like — so this models drift rather than inventing an impossible database.
   */
  allowUnknownEnums?: boolean;
};

type Column = { name: string; type: string; constraints?: string };

function check(column: string, values: string[], allowUnknownEnums: boolean): string {
  return allowUnknownEnums ? '' : `\n    CHECK(${column} IN (${values.map((v) => `'${v}'`).join(', ')}))`;
}

function tableColumns(table: string, options: Required<SchemaOptions>): Column[] {
  const { userVersion, allowUnknownEnums } = options;
  const columns: Record<string, Column[]> = {
    tasks: [
      { name: 'id', type: 'TEXT', constraints: 'PRIMARY KEY' },
      { name: 'parent_id', type: 'TEXT' },
      { name: 'created_by_terminal_handle', type: 'TEXT' },
      { name: 'task_title', type: 'TEXT' },
      { name: 'display_name', type: 'TEXT' },
      { name: 'spec', type: 'TEXT', constraints: 'NOT NULL' },
      {
        name: 'status',
        type: 'TEXT',
        constraints: `NOT NULL DEFAULT 'pending'${check('status', TASK_STATUSES, allowUnknownEnums)}`,
      },
      { name: 'deps', type: 'TEXT', constraints: "NOT NULL DEFAULT '[]'" },
      { name: 'result', type: 'TEXT' },
      { name: 'created_at', type: 'TEXT', constraints: "NOT NULL DEFAULT (datetime('now'))" },
      { name: 'completed_at', type: 'TEXT' },
    ],
    dispatch_contexts: [
      { name: 'id', type: 'TEXT', constraints: 'PRIMARY KEY' },
      { name: 'task_id', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'assignee_handle', type: 'TEXT' },
      {
        name: 'status',
        type: 'TEXT',
        constraints: `NOT NULL DEFAULT 'pending'${check('status', DISPATCH_STATUSES, allowUnknownEnums)}`,
      },
      { name: 'failure_count', type: 'INTEGER', constraints: 'NOT NULL DEFAULT 0' },
      { name: 'last_failure', type: 'TEXT' },
      { name: 'dispatched_at', type: 'TEXT' },
      { name: 'completed_at', type: 'TEXT' },
      { name: 'created_at', type: 'TEXT', constraints: "NOT NULL DEFAULT (datetime('now'))" },
      { name: 'last_heartbeat_at', type: 'TEXT' },
    ],
    messages: [
      { name: 'id', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'from_handle', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'to_handle', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'subject', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'body', type: 'TEXT', constraints: "NOT NULL DEFAULT ''" },
      {
        name: 'type',
        type: 'TEXT',
        constraints: `NOT NULL DEFAULT 'status'${check('type', MESSAGE_TYPES, allowUnknownEnums)}`,
      },
      {
        name: 'priority',
        type: 'TEXT',
        constraints: `NOT NULL DEFAULT 'normal'${check('priority', MESSAGE_PRIORITIES, allowUnknownEnums)}`,
      },
      { name: 'thread_id', type: 'TEXT' },
      { name: 'payload', type: 'TEXT' },
      { name: 'read', type: 'INTEGER', constraints: 'NOT NULL DEFAULT 0' },
      { name: 'sequence', type: 'INTEGER', constraints: 'PRIMARY KEY AUTOINCREMENT' },
      { name: 'created_at', type: 'TEXT', constraints: "NOT NULL DEFAULT (datetime('now'))" },
      { name: 'delivered_at', type: 'TEXT' },
    ],
    decision_gates: [
      { name: 'id', type: 'TEXT', constraints: 'PRIMARY KEY' },
      { name: 'task_id', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'question', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'options', type: 'TEXT', constraints: "NOT NULL DEFAULT '[]'" },
      {
        name: 'status',
        type: 'TEXT',
        constraints: `NOT NULL DEFAULT 'pending'${check('status', GATE_STATUSES, allowUnknownEnums)}`,
      },
      { name: 'resolution', type: 'TEXT' },
      { name: 'created_at', type: 'TEXT', constraints: "NOT NULL DEFAULT (datetime('now'))" },
      { name: 'resolved_at', type: 'TEXT' },
    ],
    coordinator_runs: [
      { name: 'id', type: 'TEXT', constraints: 'PRIMARY KEY' },
      { name: 'spec', type: 'TEXT', constraints: 'NOT NULL' },
      {
        name: 'status',
        type: 'TEXT',
        constraints: `NOT NULL DEFAULT 'idle'${check('status', COORDINATOR_STATUSES, allowUnknownEnums)}`,
      },
      { name: 'coordinator_handle', type: 'TEXT', constraints: 'NOT NULL' },
      { name: 'poll_interval_ms', type: 'INTEGER', constraints: 'NOT NULL DEFAULT 2000' },
      { name: 'created_at', type: 'TEXT', constraints: "NOT NULL DEFAULT (datetime('now'))" },
      { name: 'completed_at', type: 'TEXT' },
    ],
  };

  const table_ = columns[table];
  if (!table_) throw new Error(`unknown table: ${table}`);
  return table_.filter((column) => (COLUMN_ADDED_AT[`${table}.${column.name}`] ?? 1) <= userVersion);
}

/** The tables a fixture creates, in the order Orca's own `db.ts` creates them. */
export const TABLES = ['tasks', 'dispatch_contexts', 'messages', 'decision_gates', 'coordinator_runs'] as const;

export type TableName = (typeof TABLES)[number];

/** The columns a table has at a given schema version — the fixture's own source of truth. */
export function columnsOf(table: TableName, options: SchemaOptions = {}): string[] {
  return tableColumns(table, withDefaults(options)).map((column) => column.name);
}

function withDefaults(options: SchemaOptions): Required<SchemaOptions> {
  return {
    userVersion: options.userVersion ?? CURRENT_SCHEMA_VERSION,
    allowUnknownEnums: options.allowUnknownEnums ?? false,
  };
}

/** The `CREATE TABLE` / `CREATE INDEX` / `PRAGMA user_version` statements for a fixture. */
export function schemaSql(options: SchemaOptions = {}): string {
  const resolved = withDefaults(options);

  const tables = TABLES.map((table) => {
    const columns = tableColumns(table, resolved)
      .map((column) => `  ${column.name} ${column.type}${column.constraints ? ` ${column.constraints}` : ''}`)
      .join(',\n');
    return `CREATE TABLE ${table} (\n${columns}\n);`;
  });

  const indexes = [
    'CREATE INDEX idx_tasks_status ON tasks(status);',
    'CREATE INDEX idx_tasks_parent ON tasks(parent_id);',
    'CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id);',
    'CREATE INDEX idx_dispatch_status ON dispatch_contexts(status);',
    'CREATE UNIQUE INDEX idx_messages_id ON messages(id);',
    'CREATE INDEX idx_inbox ON messages(to_handle, read);',
    'CREATE INDEX idx_thread ON messages(thread_id);',
    'CREATE INDEX idx_gates_task ON decision_gates(task_id);',
    'CREATE INDEX idx_gates_status ON decision_gates(status);',
  ];
  if (resolved.userVersion >= 3) {
    indexes.push(
      'CREATE INDEX idx_messages_undelivered_inbox ON messages(to_handle, read, delivered_at, sequence);'
    );
  }

  return [...tables, ...indexes, `PRAGMA user_version = ${resolved.userVersion};`].join('\n');
}

import { afterEach, describe, expect, it } from 'vitest';
import { FixtureBuilder, handleFor } from './builder.ts';
import { closeFixtures, count, openFixture, rows } from './read.ts';
import { tempDbPath } from './temp-dir.ts';

/**
 * The fixture builder is tested through the file it writes: build a database, open it
 * `readOnly: true` exactly as the tool will, and assert its shape. Nothing here reaches
 * inside the builder — the SQLite file on disk is the whole contract.
 *
 * Each test below is one of the traps in SPEC §4.2: a shape the real database has and a
 * tidy fixture does not, so that an implementation which gets it wrong fails a test here
 * instead of shipping a permanently empty panel.
 */

afterEach(closeFixtures);

const AT = new Date('2026-07-08T12:32:13Z');
const LATER = new Date('2026-07-08T12:38:28.374Z');
const CODER = handleFor('coder');
const COORDINATOR = handleFor('coordinator');

const columnsOfTable = (db: Parameters<typeof rows>[0], table: string) =>
  rows(db, `PRAGMA table_info(${table})`).map((column) => column.name);

describe('the fixture database', () => {
  it('creates Orca schema v5 — all five tables, user_version 5', () => {
    const db = openFixture(new FixtureBuilder());

    const tables = rows(
      db,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).map((row) => row.name);

    expect(tables).toEqual(['coordinator_runs', 'decision_gates', 'dispatch_contexts', 'messages', 'tasks']);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
  });

  it('is reproducible: the same inputs make the same rows', () => {
    const build = () => new FixtureBuilder().task({ createdAt: AT, handle: CODER, title: 'ship it' });

    const [first] = rows(openFixture(build()), 'SELECT * FROM tasks');
    const [second] = rows(openFixture(build()), 'SELECT * FROM tasks');

    expect(first).toEqual(second);
    expect(first?.id).toMatch(/^task_[0-9a-f]{12}$/);
  });
});

describe('the traps (SPEC §4.2)', () => {
  it('trap 1: gate messages exist with zero decision_gates rows', () => {
    const db = openFixture(
      new FixtureBuilder().message({
        type: 'decision_gate',
        fromHandle: CODER,
        toHandle: COORDINATOR,
        subject: 'Which database driver?',
        payload: { question: 'Which database driver?', options: ['node:sqlite', 'better-sqlite3'] },
        createdAt: AT,
      })
    );

    expect(count(db, `SELECT COUNT(*) AS n FROM messages WHERE type = 'decision_gate'`)).toBe(1);
    expect(count(db, 'SELECT COUNT(*) AS n FROM decision_gates')).toBe(0);
  });

  it('trap 1 (additive): decision_gates rows can still be written, for the merge case', () => {
    const db = openFixture(
      new FixtureBuilder().gate({ taskId: 'task_abc', question: 'Which driver?', options: ['a', 'b'], createdAt: AT })
    );

    expect(rows(db, 'SELECT task_id, question, options, status FROM decision_gates')).toEqual([
      { task_id: 'task_abc', question: 'Which driver?', options: '["a","b"]', status: 'pending' },
    ]);
  });

  it('trap 5: timestamps are split — SQL format everywhere except the two ISO columns', () => {
    const db = openFixture(
      new FixtureBuilder()
        .task({ id: 'task_1', createdAt: AT, completedAt: LATER, handle: CODER, status: 'completed' })
        .dispatch({ taskId: 'task_1', dispatchedAt: AT, completedAt: LATER, lastHeartbeatAt: AT })
        .message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'done', createdAt: AT, deliveredAt: LATER })
        .coordinatorRun({ spec: 'a run', coordinatorHandle: COORDINATOR, createdAt: AT, completedAt: LATER })
    );

    // The SQL side: 'YYYY-MM-DD HH:MM:SS', UTC, no zone marker.
    const SQL_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    const task = rows(db, 'SELECT created_at, completed_at FROM tasks')[0]!;
    const dispatch = rows(db, 'SELECT dispatched_at, completed_at, last_heartbeat_at FROM dispatch_contexts')[0]!;
    const message = rows(db, 'SELECT created_at, delivered_at FROM messages')[0]!;
    const run = rows(db, 'SELECT created_at, completed_at FROM coordinator_runs')[0]!;

    expect(task.created_at).toBe('2026-07-08 12:32:13');
    expect(dispatch.dispatched_at).toMatch(SQL_FORMAT);
    expect(dispatch.completed_at).toMatch(SQL_FORMAT);
    expect(dispatch.last_heartbeat_at).toMatch(SQL_FORMAT);
    expect(message.created_at).toMatch(SQL_FORMAT);
    expect(message.delivered_at).toMatch(SQL_FORMAT);
    expect(run.created_at).toMatch(SQL_FORMAT);

    // The JS side: exactly two columns in the whole schema carry ISO-8601.
    expect(task.completed_at).toBe('2026-07-08T12:38:28.374Z');
    expect(run.completed_at).toBe('2026-07-08T12:38:28.374Z');
  });

  it('trap 8: a task can have a NULL created_by_terminal_handle', () => {
    const db = openFixture(
      new FixtureBuilder().task({ createdAt: AT, handle: null }).task({ createdAt: AT, handle: CODER })
    );

    expect(count(db, 'SELECT COUNT(*) AS n FROM tasks WHERE created_by_terminal_handle IS NULL')).toBe(1);
  });

  it('trap 8: a message payload.taskId can point at a task that no longer exists', () => {
    const db = openFixture(
      new FixtureBuilder().task({ id: 'task_alive', createdAt: AT, handle: CODER }).message({
        type: 'worker_done',
        fromHandle: CODER,
        toHandle: COORDINATOR,
        subject: 'done',
        payload: { taskId: 'task_wiped_by_a_reset' },
        createdAt: AT,
      })
    );

    // No foreign keys: the reference survives the task. Any message → task join must miss.
    expect(rows(db, `SELECT json_extract(payload, '$.taskId') AS task_id FROM messages`)).toEqual([
      { task_id: 'task_wiped_by_a_reset' },
    ]);
    expect(count(db, `SELECT COUNT(*) AS n FROM tasks WHERE id = 'task_wiped_by_a_reset'`)).toBe(0);
  });

  it('one task can have several dispatch_contexts rows — the retry and circuit-breaker story', () => {
    const db = openFixture(
      new FixtureBuilder()
        .task({ id: 'task_flaky', createdAt: AT, handle: CODER, status: 'failed' })
        .dispatch({ taskId: 'task_flaky', status: 'failed', failureCount: 1, dispatchedAt: AT, lastFailure: AT })
        .dispatch({ taskId: 'task_flaky', status: 'failed', failureCount: 2, dispatchedAt: AT, lastFailure: AT })
        .dispatch({
          taskId: 'task_flaky',
          status: 'circuit_broken',
          failureCount: 3,
          dispatchedAt: LATER,
          lastFailure: LATER,
        })
    );

    expect(
      rows(db, `SELECT status, failure_count FROM dispatch_contexts WHERE task_id = 'task_flaky' ORDER BY rowid`)
    ).toEqual([
      { status: 'failed', failure_count: 1 },
      { status: 'failed', failure_count: 2 },
      { status: 'circuit_broken', failure_count: 3 },
    ]);
    // The latest attempt is MAX(rowid) — the source's own queries do this (SPEC §4.1).
    expect(count(db, 'SELECT failure_count AS n FROM dispatch_contexts ORDER BY rowid DESC LIMIT 1')).toBe(3);
  });

  it('an orchestration reset leaves a gap between sqlite_sequence and the surviving messages', () => {
    const db = openFixture(
      new FixtureBuilder().message({
        fromHandle: CODER,
        toHandle: COORDINATOR,
        subject: 'after the reset',
        sequence: 407,
        createdAt: AT,
      })
    );

    expect(count(db, 'SELECT MIN(sequence) AS n FROM messages')).toBe(407);
    expect(count(db, `SELECT seq AS n FROM sqlite_sequence WHERE name = 'messages'`)).toBe(407);
    expect(count(db, 'SELECT COUNT(*) AS n FROM messages')).toBe(1);
  });
});

describe('schema drift (SPEC §5)', () => {
  it('user_version 4: task_title and display_name are genuinely absent', () => {
    const db = openFixture(
      new FixtureBuilder({ userVersion: 4 }).task({ createdAt: AT, handle: CODER, title: 'dropped on the floor' })
    );

    expect(columnsOfTable(db, 'tasks')).not.toContain('task_title');
    expect(columnsOfTable(db, 'tasks')).not.toContain('display_name');
    expect(columnsOfTable(db, 'tasks')).toContain('created_by_terminal_handle');
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 4 });
    expect(count(db, 'SELECT COUNT(*) AS n FROM tasks')).toBe(1);
  });

  it('user_version 3: created_by_terminal_handle is absent too, so every task is unattributed', () => {
    const db = openFixture(new FixtureBuilder({ userVersion: 3 }).task({ createdAt: AT, handle: CODER }));

    expect(columnsOfTable(db, 'tasks')).not.toContain('created_by_terminal_handle');
    expect(columnsOfTable(db, 'messages')).toContain('delivered_at');
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 3 });
  });

  it('user_version 6: a newer Orca, whose data still reads', () => {
    const db = openFixture(new FixtureBuilder({ userVersion: 6 }).task({ createdAt: AT, handle: CODER }));

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 });
    expect(columnsOfTable(db, 'tasks')).toContain('task_title');
    expect(count(db, 'SELECT COUNT(*) AS n FROM tasks')).toBe(1);
  });

  it('unknown task statuses and message types survive in the file', () => {
    const db = openFixture(
      new FixtureBuilder({ userVersion: 6, allowUnknownEnums: true })
        .task({ createdAt: AT, handle: CODER, status: 'quarantined' })
        .message({ type: 'gossip', fromHandle: CODER, toHandle: COORDINATOR, subject: 'psst', createdAt: AT })
    );

    expect(rows(db, 'SELECT status FROM tasks')).toEqual([{ status: 'quarantined' }]);
    expect(rows(db, 'SELECT type FROM messages')).toEqual([{ type: 'gossip' }]);
  });

  it('rejects an unknown status at v5, because the real v5 CHECK constraint would', () => {
    expect(() =>
      new FixtureBuilder().task({ createdAt: AT, handle: CODER, status: 'quarantined' }).write(tempDbPath())
    ).toThrow(/CHECK constraint failed/);
  });

  it('can drop the DAG core: a tasks table with no deps column at all', () => {
    // SPEC §5's one legal hard-fail — the tool may refuse a database it cannot read the
    // graph out of. Without a fixture that has no `deps`, that path cannot be tested.
    const db = openFixture(
      new FixtureBuilder({ omitColumns: { tasks: ['deps'] } }).task({ createdAt: AT, handle: CODER })
    );

    expect(columnsOfTable(db, 'tasks')).not.toContain('deps');
    expect(columnsOfTable(db, 'tasks')).toContain('status');
    expect(count(db, 'SELECT COUNT(*) AS n FROM tasks')).toBe(1);
  });
});

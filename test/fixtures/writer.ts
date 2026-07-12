import { DatabaseSync } from 'node:sqlite';
import { type MessageInput, sqlTime, syntheticId } from './builder.ts';

/**
 * The test, as the database's writer.
 *
 * `FixtureBuilder` writes a database and closes it — a *past* orchestration, complete before
 * the server ever opens it. The streaming tests (#17) need the other thing: a database that
 * changes **while the server is reading it**, which is the only way to prove that a push
 * happens, that an idle tick pushes nothing, and that the cursor advances.
 *
 * Orca is not running during the suite, so the test is legitimately the single writer (SPEC
 * §1.2 forbids *orca-viz* from writing, not the test that plays Orca). It writes on its own
 * connection, exactly as Orca does, and the server finds out the way it will in production:
 * from `PRAGMA data_version` on its own read-only connection. There is no test-only
 * notification anywhere in this file, which is the point of it.
 */
export class FixtureWriter {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    // Read-write, and deliberately a *second* connection: `data_version` only moves for
    // commits made elsewhere, so a writer sharing the server's connection would prove nothing.
    this.db = new DatabaseSync(dbPath);
  }

  /** Append a message and return the `sequence` SQLite handed it — the new high-water mark. */
  message(input: MessageInput): number {
    const statement = this.db.prepare(
      `INSERT INTO messages (id, from_handle, to_handle, subject, body, type, priority, thread_id, payload, read, created_at, delivered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const { lastInsertRowid } = statement.run(
      input.id ?? syntheticId('msg', `written:${input.subject}:${input.createdAt.toISOString()}`),
      input.fromHandle,
      input.toHandle,
      input.subject,
      input.body ?? '',
      input.type ?? 'status',
      input.priority ?? 'normal',
      input.threadId ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.read ? 1 : 0,
      sqlTime(input.createdAt),
      input.deliveredAt ? sqlTime(input.deliveredAt) : null
    );

    // `sequence` is INTEGER PRIMARY KEY AUTOINCREMENT, so it *is* the rowid.
    return Number(lastInsertRowid);
  }

  /**
   * A graph change that adds no message — a `ready → dispatched` flip.
   *
   * This is the case that separates the change detector from the cursor: `data_version`
   * moves, `MAX(messages.sequence)` does not.
   */
  setTaskStatus(taskId: string, status: string): void {
    this.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  }

  close(): void {
    this.db.close();
  }
}

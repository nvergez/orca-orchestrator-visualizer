import type { DatabaseSync } from 'node:sqlite';
import { parsePayload, taskIdOf } from '../shared/payload.ts';
import type { HistoryLoss } from '../shared/types.ts';
import {
  GRAPH_OWNED_TABLES,
  hasColumn,
  MESSAGE_SEQUENCE,
  type SchemaReport,
  TASK_GRAPH_EVIDENCE_COLUMNS,
} from './schema.ts';

/**
 * What retained history is observably missing (SPEC §5.1, #50).
 *
 * A reset is not an event in this database — nothing anywhere records that one ran. What the
 * file *can* prove is a shape: rows it once held and no longer does. So each signal here names
 * the history surface that is missing and the structural evidence for it, and the wording built
 * on top says the shape "matches" a reset rather than claiming to know what caused it
 * (CONTEXT.md, ADR 0003). An empty answer means there is no safe history-loss claim to make.
 *
 * Both detectors are *features*, and degrade like features (`FEATURES` in schema.ts): an Orca
 * missing a column a signal needs gets that signal suppressed and is told so in
 * `meta.degraded`, rather than being asked a question SQLite would answer by throwing.
 */

/**
 * Stable order: message history first, then task graph history — the order `Meta.historyLoss`
 * promises, so the two notices cannot shuffle between polls (SPEC §5.1).
 */
export function detectHistoryLoss(db: DatabaseSync, columns: SchemaReport['columns']): HistoryLoss[] {
  // One read snapshot for every signal. The task-graph shape is two halves — four empty
  // tables, and a retained message that still points into them — and combining halves
  // observed on different poll ticks could briefly announce loss while Orca is busy
  // creating new work (SPEC §5.1). A deferred read transaction pins one WAL snapshot for
  // the whole derivation; it holds no lock a writer would feel, and it is committed before
  // this function returns.
  db.exec('BEGIN');
  try {
    const loss: HistoryLoss[] = [];
    if (messageHistoryLost(db, columns)) loss.push('message-history');
    if (taskGraphHistoryLost(db, columns)) loss.push('task-graph-history');
    return loss;
  } finally {
    try {
      db.exec('COMMIT');
    } catch {
      // A failing statement can auto-rollback the transaction, and then COMMIT throws "no
      // transaction is active" — the original error is the one worth surfacing, not this.
    }
  }
}

/**
 * Did message rows this database once held disappear?
 *
 * `messages.sequence` is AUTOINCREMENT, so `sqlite_sequence` remembers the highest id ever
 * handed out even after the rows are deleted. A counter that has run ahead of the surviving
 * rows — or a surviving range that no longer starts at 1 — is evidence that messages were
 * removed, and it is the difference between a mysteriously empty history and an explained
 * one (SPEC §5.1).
 */
function messageHistoryLost(db: DatabaseSync, columns: SchemaReport['columns']): boolean {
  if (!hasColumn(columns, MESSAGE_SEQUENCE)) return false;

  let counter: number;
  try {
    const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'").get() as
      | { seq: number }
      | undefined;
    if (!row) return false; // No message has ever been written: nothing to have lost.
    counter = row.seq;
  } catch {
    return false; // No sqlite_sequence at all — not a database that can tell us.
  }

  const { n, lowest, highest } = db
    .prepare('SELECT COUNT(*) AS n, MIN(sequence) AS lowest, MAX(sequence) AS highest FROM messages')
    .get() as { n: number; lowest: number | null; highest: number | null };

  if (n === 0) return counter > 0; // Every message deleted, but the counter remembers them.
  return lowest! > 1 || counter > highest!;
}

/**
 * Did the task graph disappear out from under the retained messages?
 *
 * This is exactly the shape `orchestration reset --tasks` leaves — and the shape the message
 * detector above is structurally blind to, because a tasks-only reset deliberately keeps
 * `messages` and its sequence state untouched (#50). Both halves must hold in the one
 * snapshot the caller pinned:
 *
 * 1. `tasks`, `dispatch_contexts`, `decision_gates` and `coordinator_runs` all have zero
 *    rows; and
 * 2. at least one retained `messages.payload` still parses to an object with a non-empty
 *    string `taskId` — a message that was once *about* graph work this file no longer has.
 *
 * Deliberately narrower than "many task ids do not resolve" (SPEC §5.1): orphaned task
 * references are a normal, supported shape after an earlier reset, and any surviving graph
 * row — new work — silences this signal for good. A false negative once new work exists is
 * the accepted price; the signal exists to explain the empty canvas beside a retained
 * conversation, not to be a forensic classifier of every historical reset.
 */
function taskGraphHistoryLost(db: DatabaseSync, columns: SchemaReport['columns']): boolean {
  // Verified through introspection before anything is asked of SQLite (SPEC §5.1): a missing
  // requirement suppresses the signal — and names the degraded detector (`FEATURES`) —
  // rather than guessing, or throwing on a table that is not really there.
  if (!TASK_GRAPH_EVIDENCE_COLUMNS.every((column) => hasColumn(columns, column))) return false;

  // All four counts in one statement: the emptiness is one fact about one snapshot, not
  // four facts about four moments.
  const graph = db
    .prepare(`SELECT ${GRAPH_OWNED_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table})`).join(' + ')} AS surviving`)
    .get() as { surviving: number };
  if (graph.surviving > 0) return false;

  // The retained half of the evidence, through the one payload reader every other feature
  // uses (`shared/payload.ts`): whatever does not parse — or parses to anything but an
  // object with a non-empty string taskId — answers "no task reference here", quietly.
  const payloads = db.prepare('SELECT payload FROM messages WHERE payload IS NOT NULL').all() as {
    payload: unknown;
  }[];
  return payloads.some((row) => taskIdOf(parsePayload(row.payload)) !== null);
}

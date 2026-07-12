import type { DatabaseSync } from 'node:sqlite';
import type { FeedMessage } from '../shared/types.ts';
import type { Attribution } from './attribution.ts';
import { type Columns, type Row, text } from './rows.ts';
import { hasColumn, MESSAGE_SEQUENCE } from './schema.ts';
import { isoInstant } from './time.ts';

/**
 * The message feed, read **after a cursor** — the one place in this schema where a delta is
 * both cheap and correct (SPEC §6.3).
 *
 * Everything else the server reads is overwritten in place, so it is re-read whole on every
 * push. Message rows are immutable once written and `sequence` is AUTOINCREMENT, gap-free
 * and append-only — so `WHERE sequence > <cursor>` is a complete, trustworthy delta, and
 * the client can simply append what arrives.
 *
 * `read` and `delivered_at` are the exceptions that prove it: they are mutable flags on an
 * otherwise-immutable row. They are **not selected and not rendered** (internal mailbox
 * bookkeeping, not orchestration semantics — SPEC §6.3), so their mutability never bites.
 *
 * **Heartbeats are read and sent like everything else.** They are 65% of the traffic and the
 * feed hides them by default (SPEC §7.7) — but the hiding is the *client's*, because the
 * toggle is. Filtering them out of the payload would put rows the user can ask for behind a
 * cursor that has already passed them, and the whole promise of an append-only feed is that
 * what has been sent never has to be sent again.
 *
 * Where each message *belongs* is `attribution.ts`'s: two rules of unequal strength, and the
 * discipline to answer null when neither settles it.
 */

/** Read if present. `sequence` is the cursor — without it there is no feed to serve. */
const MESSAGE_COLUMNS = [
  'id',
  'sequence',
  'from_handle',
  'to_handle',
  'subject',
  'body',
  'type',
  'priority',
  'thread_id',
  'payload',
  'created_at',
] as const;

export type MessageOptions = {
  /** Send what is newer than this. 0 — a first connect — means the whole feed. */
  since: number;
  /** Where a message belongs: the task it names, and the run that task (or its handles) puts it in. */
  attribution: Attribution;
};

export function readMessages(db: DatabaseSync, columns: Columns, { since, attribution }: MessageOptions): FeedMessage[] {
  // No `sequence` column is no cursor, and a feed with no order is not a feed. An Orca that
  // old degrades to the graph, which is the whole of "render what parses" (SPEC §5) — and it
  // degrades in step with `highWaterMark`, which is guarded on this very same column, so the
  // event id and the feed cannot disagree about whether there is a cursor.
  if (!hasColumn(columns, MESSAGE_SEQUENCE)) return [];

  // Never a column that has not been confirmed (#21) — the same rule `selectPresent` enforces
  // for whole-table reads, applied by hand because this is the one read that is *not* one.
  // The cursor is the point of it: `selectPresent` reads a table end to end, which is right for
  // rows that are overwritten in place and wrong for an append-only log the client has already
  // seen most of.
  const present = MESSAGE_COLUMNS.filter((column) => columns.messages.has(column));

  const rows = db
    .prepare(`SELECT ${present.join(', ')} FROM messages WHERE sequence > ? ORDER BY sequence`)
    .all(since) as Row[];

  return rows.map((row) => feedMessage(row, attribution));
}

function feedMessage(row: Row, attribution: Attribution): FeedMessage {
  const payload = parsePayload(row.payload);

  const fromHandle = text(row.from_handle);
  const toHandle = text(row.to_handle);
  const createdAt = isoInstant(row.created_at) ?? '';

  // A message points at a task that no longer exists whenever a reset has been through here —
  // there are no foreign keys in this schema. That costs the row its link, never the row.
  const { taskId, runId } = attribution.attribute({
    taskId: taskIdOf(payload),
    fromHandle,
    toHandle,
    createdAt,
  });

  return {
    id: text(row.id) ?? '',
    sequence: Number(row.sequence),
    type: text(row.type) ?? '',
    fromHandle: fromHandle ?? '',
    toHandle: toHandle ?? '',
    subject: text(row.subject) ?? '',
    body: text(row.body) ?? '',
    priority: text(row.priority) ?? '',
    threadId: text(row.thread_id),
    payload,
    createdAt,
    taskId,
    runId,
  };
}

/** The column is TEXT holding JSON. Whatever does not parse is passed through as it was written. */
function parsePayload(value: unknown): unknown {
  const raw = text(value);
  if (raw === null) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function taskIdOf(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return text((payload as { taskId?: unknown }).taskId);
}

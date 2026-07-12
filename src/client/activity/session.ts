import { shortHandle } from '../../shared/handles.ts';
import type { StreamEvent, Task } from '../../shared/types.ts';

/**
 * **Session activity** (#58): what this browser session has *watched happen*, and nothing more.
 *
 * The database records almost none of its own transitions (SPEC §4.2, trap 6): six writers flip
 * `tasks.status` in place, a dispatch writes no message, and a retry is only legible as a fresh
 * `dispatch_contexts` row. So "what just changed" cannot be read out of any table — but it *can*
 * be observed, by diffing the snapshot the stream just pushed against the one before it. That
 * diff, merged with the message delta (`StreamEvent.messages`, coherent with its snapshot since
 * #49), is the ticker.
 *
 * It is explicitly a **session** log, not replay: the first snapshot is a baseline that narrates
 * nothing (four days of history is the *page*, not news), the list lives in this module's caller's
 * memory and nowhere else — no localStorage, no IndexedDB, no server, and certainly not the one
 * database this tool must never write to (SPEC §1.2) — and it dies with the tab. Reconstructing
 * *when* an unrecorded transition happened is out of scope by ticket: an entry wears the instant
 * this session observed it, which is the only instant that is true.
 */

/** The ticker keeps the newest 100 entries and lets the rest go — a log, not an archive. */
export const MAX_ACTIVITY_ENTRIES = 100;

export type ActivityEntry = {
  /**
   * Stable within the session: `status:<taskId>:<tick>`, `dispatch:<contextId>`,
   * `retry:<contextId>`, `msg:<sequence>` — with an `r<epoch>` segment after a reset has
   * renumbered sequences (`msg:r1:<sequence>`), so a reused number cannot collide with a
   * retained pre-reset entry. Observing the same change again — a repeated snapshot, a
   * replayed message — can only produce the same identity, never a second entry.
   */
  id: string;
  /** The three synthesized transitions, or the message type that arrived verbatim. */
  kind: 'status' | 'dispatch' | 'retry' | 'decision_gate' | 'escalation' | 'worker_done';
  /**
   * A message entry wears the instant Orca wrote it. A synthesized entry wears the instant this
   * session **observed** it — the transition's own instant was never recorded (SPEC §4.2, trap 6),
   * and inventing one is out of scope by ticket.
   */
  at: string;
  /** The narration, whole: "Build it · dispatched → completed". */
  text: string;
  /** Destination for a click — the task this happened to, when one still exists. */
  taskId: string | null;
  /** A status entry's destination status, for the dot that wears its colour. Absent elsewhere. */
  status?: string;
};

/** What must change about a task before this session has something to say about it. */
type TaskMark = { status: string; dispatchId: string | null; attemptCount: number };

/**
 * Everything the session remembers. Opaque to the caller: build one with the first event,
 * fold every later event into it, render `entries`.
 */
export type ActivityLog = {
  /** Oldest → newest, at most `MAX_ACTIVITY_ENTRIES`. The same reference when a fold added nothing. */
  readonly entries: readonly ActivityEntry[];
  /** Per-task fingerprints the next diff compares against. */
  readonly marks: ReadonlyMap<string, TaskMark>;
  /**
   * The message high-water mark — `event.seq` of the last fold. A message at or below it has
   * already been seen (or predates the session) and is never narrated, whatever a reconnect
   * replays.
   */
  readonly seq: number;
  /** How many folds this log has absorbed — the disambiguator in a status entry's id. */
  readonly ticks: number;
  /**
   * How many resets this session has lived through — a cursor that went *down* means an
   * `orchestration reset` renumbered the messages, and a renumbered sequence must not mint
   * the id of a pre-reset entry the list still holds.
   */
  readonly epoch: number;
};

/**
 * Fold one `StreamEvent` into the log.
 *
 * With no log yet, the event **is the baseline**: every task is fingerprinted, the message
 * cursor is set, and nothing is narrated — first connect delivers the entire feed
 * (`EventStream.subscribe`, since = 0), and all of it is pre-session history.
 *
 * Folding is idempotent: the same event again — a repeated snapshot, a `StrictMode` double
 * effect, a reconnect replay — finds every fingerprint already current and every sequence
 * already below the high-water mark, and returns `entries` by the same reference.
 */
export function observeActivity(log: ActivityLog | null, event: StreamEvent, observedAt: string): ActivityLog {
  const marks = new Map<string, TaskMark>();
  for (const task of event.snapshot.tasks) marks.set(task.id, markOf(task));

  if (log === null) return { entries: [], marks, seq: event.seq, ticks: 0, epoch: 0 };

  const ticks = log.ticks + 1;
  const epoch = event.seq < log.seq ? log.epoch + 1 : log.epoch;
  const fresh: ActivityEntry[] = [];
  const monograms = monogramsOf(event);

  for (const task of event.snapshot.tasks) {
    const before = log.marks.get(task.id);
    const attempt = task.dispatch;
    const dispatched = attempt !== null && attempt.id !== before?.dispatchId;

    if (dispatched) {
      // A retry is a dispatch whose task was already attempted — a genuinely separate thing the
      // orchestrator did, to a fresh worktree with a fresh handle (SPEC §4.7, rule 1).
      const retried = before !== undefined && task.attemptCount > before.attemptCount && before.attemptCount > 0;
      const agent = monograms.get(attempt.assigneeHandle) ?? shortHandle(attempt.assigneeHandle);

      fresh.push({
        id: `${retried ? 'retry' : 'dispatch'}:${attempt.id}`,
        kind: retried ? 'retry' : 'dispatch',
        at: observedAt,
        text: retried
          ? `${task.title} · retry, attempt ${task.attemptCount} → ${agent}`
          : `${task.title} · dispatched → ${agent}`,
        taskId: task.id,
      });
    }

    // A task this session never fingerprinted has no from-state to narrate; a status change the
    // dispatch entry already means — the arrival into `dispatched` — would be the same fact twice.
    if (before === undefined) continue;
    if (before.status === task.status) continue;
    if (dispatched && task.status === 'dispatched') continue;

    fresh.push({
      id: `status:${task.id}:${ticks}`,
      kind: 'status',
      at: observedAt,
      text: `${task.title} · ${before.status} → ${task.status}`,
      taskId: task.id,
      status: task.status,
    });
  }

  for (const message of event.messages) {
    // Only what is genuinely news: a sequence at or below the high-water mark is a replay, or —
    // on the first event and any full resync — pre-session history. #49 is what makes this
    // trustworthy: the delta's sequences are derived from the same rows as its snapshot, so a
    // real message cannot hide behind the cursor.
    if (message.sequence <= log.seq) continue;
    // The three deltas the ticket names, and only those. An unknown message type is not dropped
    // from the *page* — the conversation renders it verbatim (SPEC §5) — it is simply not one of
    // the ticker's narrations.
    if (message.type !== 'decision_gate' && message.type !== 'escalation' && message.type !== 'worker_done') continue;

    fresh.push({
      id: epoch === 0 ? `msg:${message.sequence}` : `msg:r${epoch}:${message.sequence}`,
      kind: message.type,
      at: message.createdAt,
      text: message.subject !== '' ? message.subject : message.body.slice(0, 120),
      taskId: message.taskId,
    });
  }

  // One chronological list. A message wears the instant Orca wrote it, a synthesized transition
  // the instant it was observed — the write always precedes the observation, so the sort is real
  // chronology, and it is stable, so equal instants keep their deterministic construction order.
  fresh.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return {
    entries: fresh.length === 0 ? log.entries : [...log.entries, ...fresh].slice(-MAX_ACTIVITY_ENTRIES),
    marks,
    // `event.seq` even when it went *down*: after an `orchestration reset` the server's cursor
    // follows the file (`EventStream.deliver`), and a mark that refused to would filter every
    // future message as a duplicate — a ticker that never speaks again.
    seq: event.seq,
    ticks,
    epoch,
  };
}

function markOf(task: Task): TaskMark {
  return { status: task.status, dispatchId: task.dispatch?.id ?? null, attemptCount: task.attemptCount };
}

/**
 * Every agent the snapshot knows, by handle — so a dispatch entry names the same `A2` the rail,
 * the node and the conversation do (SPEC §4.3a), and falls back to the short handle only for an
 * assignee no cast claims.
 */
function monogramsOf(event: StreamEvent): Map<string, string> {
  const monograms = new Map<string, string>();
  for (const run of event.snapshot.runs) {
    for (const member of run.cast) monograms.set(member.handle, member.monogram);
  }
  return monograms;
}

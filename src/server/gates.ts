import type { DatabaseSync } from 'node:sqlite';
import { parsePayload, taskIdOf } from '../shared/payload.ts';
import type { Gate, Run, Task } from '../shared/types.ts';
import type { Attribution } from './attribution.ts';
import { type Columns, selectPresent, selectWhere, text } from './rows.ts';
import { GATE_MESSAGE_COLUMNS, hasColumn } from './schema.ts';
import { byInstant, isoInstant } from './time.ts';

/**
 * Decision gates — **the highest-value trap in the whole schema** (SPEC §4.2, trap 1; §4.5).
 *
 * `orchestration.ask` writes a `decision_gate` **message** and **no `decision_gates` row**. The
 * live database has **53 gate messages and 0 gate rows.** A gates-from-the-table implementation
 * renders nothing, forever, on real runs — and passes an unwitting test suite, because a tidy
 * fixture with gate rows makes it look correct. So:
 *
 * - **`messages WHERE type = 'decision_gate'` is the primary and required source.** The question
 *   and the options come from the `payload`.
 * - **A gate is resolved when a reply threads on the gate *message's* id** — `orchestration.ask`
 *   replies thread on the outbound message id, and that reply's body is the resolution. No
 *   reply → **open**, which is what raises the strip and sets `run.hasOpenGates`.
 * - **Where it belongs is `attribution.ts`'s question, not a new one.** `payload.taskId` names
 *   the task (21 of 53 live); without one, the gate attaches to its run through the same handle
 *   window every message uses, and to no node. A `taskId` naming a task a reset deleted is a
 *   broken link, not a broken gate — exactly as it is for a message (SPEC §4.2, trap 8).
 * - **The `decision_gates` table is merged in additively**, deduplicated by `(task_id,
 *   question)`, and is never the primary source. Orca's built-in `Coordinator` loop writes
 *   rows there and nothing CLI-driven ever does — so the merge can only ever *add* a gate, and
 *   can never re-introduce the empty panel.
 */

/** The `decision_gates` columns, read if the table has them. It usually has no *rows*. */
const GATE_ROW_COLUMNS = ['id', 'task_id', 'question', 'options', 'status', 'resolution', 'created_at'] as const;

/** What a gate message says. Read only from the columns the file really has (#21). */
const GATE_SELECT = ['id', 'payload', 'subject', 'from_handle', 'to_handle', 'created_at'] as const;

/** What an answer says: which gate it threads on, and what was decided. */
const REPLY_SELECT = ['id', 'thread_id', 'body'] as const;

/** A gate, and the `(task_id, question)` pair the additive table merge deduplicates on. */
type Derived = { key: string; gate: Gate };

export function readGates(db: DatabaseSync, columns: Columns, attribution: Attribution): Gate[] {
  // The primary source, when the schema can answer at all. It is *required* — a build that
  // silently fell back to the table here would ship the trap. So when the columns are not
  // there the gates are degraded by name (`schema.ts`), and the table merge below still runs:
  // additive to the last, it can only add what the messages could not.
  const readable = GATE_MESSAGE_COLUMNS.every((column) => hasColumn(columns, column));
  const fromMessages = readable ? readGateMessages(db, columns, attribution) : [];

  const merged = [...fromMessages];
  const seen = new Set(fromMessages.map((derived) => derived.key));

  for (const derived of readGateRows(db, columns, attribution)) {
    if (seen.has(derived.key)) continue; // The message already asked this question of this task.
    seen.add(derived.key);
    merged.push(derived);
  }

  // Oldest first: the question that has been blocking longest is the one at the top of the
  // strip. The id breaks a tie, so two gates asked in the same second do not swap places
  // between two polls of an otherwise unchanged database.
  return merged
    .map((derived) => derived.gate)
    .sort((a, b) => byInstant(a.createdAt, b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The gates, and the replies that answer them, in one pass over `messages`.
 *
 * Two reads rather than a join: the table has no foreign keys and a gate's answer is an
 * ordinary message that happens to carry the gate's id in `thread_id`. The first reply wins —
 * the first answer is the decision, and anything after it is conversation.
 */
function readGateMessages(db: DatabaseSync, columns: Columns, attribution: Attribution): Derived[] {
  const answers = readAnswers(db, columns);

  const gates = selectWhere(db, 'messages', columns.messages, GATE_SELECT, "WHERE type = 'decision_gate' ORDER BY rowid");

  return gates.map((row): Derived => {
    const id = text(row.id) ?? '';
    const payload = parsePayload(row.payload);
    const answer = answers.get(id) ?? null;
    const createdAt = isoInstant(row.created_at) ?? '';

    // The same two rules, and the same discipline about null, that every message goes through
    // (SPEC §4.4) — a gate is a message, and nothing about being a gate makes it easier to place.
    const rawTaskId = taskIdOf(payload);
    const { taskId, runId } = attribution.attribute({
      taskId: rawTaskId,
      fromHandle: text(row.from_handle),
      toHandle: text(row.to_handle),
      createdAt,
    });

    const question = questionOf(payload, text(row.subject));

    return {
      key: keyOf(rawTaskId, question),
      gate: {
        id,
        messageId: id,
        runId,
        taskId,
        question,
        options: stringsOf(field(payload, 'options')),
        status: answer === null ? 'open' : 'resolved',
        resolution: answer,
        createdAt,
      },
    };
  });
}

/** `thread_id` → the body of the first message that threaded on it. */
function readAnswers(db: DatabaseSync, columns: Columns): Map<string, string> {
  const answers = new Map<string, string>();

  const replies = selectWhere(db, 'messages', columns.messages, REPLY_SELECT, 'WHERE thread_id IS NOT NULL ORDER BY rowid');

  for (const row of replies) {
    const threadId = text(row.thread_id);
    if (threadId === null) continue;
    // A message cannot be its own answer. Orca threads a reply on the *outbound* id, so a row
    // whose thread is itself is a gate that opened a thread — not one that closed it.
    if (threadId === text(row.id)) continue;
    if (answers.has(threadId)) continue; // The first answer is the decision.

    answers.set(threadId, text(row.body) ?? '');
  }

  return answers;
}

/**
 * The `decision_gates` rows — **additive, never primary** (SPEC §4.5).
 *
 * A row carries no handles and no thread, so it can only be placed through its task. Without
 * one that still exists it lands in no run, and the strip — which is run-scoped — never shows
 * it. That is rule 3 again: a gate in the wrong run is a lie; a gate in no run is a gap.
 */
function readGateRows(db: DatabaseSync, columns: Columns, attribution: Attribution): Derived[] {
  const derived: Derived[] = [];

  for (const row of selectPresent(db, 'decision_gates', columns.decision_gates, GATE_ROW_COLUMNS)) {
    const question = text(row.question);
    if (question === null) continue; // A gate with no question is not a gate.

    const rawTaskId = text(row.task_id);
    const { taskId, runId } = attribution.attribute({
      taskId: rawTaskId,
      fromHandle: null,
      toHandle: null,
      createdAt: isoInstant(row.created_at) ?? '',
    });

    derived.push({
      key: keyOf(rawTaskId, question),
      gate: {
        id: text(row.id) ?? `gate_${keyOf(rawTaskId, question)}`,
        // No message asked this one — which is exactly what a null `messageId` says.
        messageId: null,
        runId,
        taskId,
        question,
        // The column is TEXT holding a JSON array — read through the same unvalidated-JSON
        // reader the payload goes through, because nothing enforces either of them.
        options: stringsOf(parsePayload(row.options)),
        // `GateStatus = 'timeout'` never occurs (SPEC §4.2, trap 9). If an Orca ever wrote one,
        // an unanswered question is still unanswered: it shows as open rather than as a state
        // nothing on screen has a word for.
        status: text(row.status) === 'resolved' ? 'resolved' : 'open',
        resolution: text(row.resolution),
        createdAt: isoInstant(row.created_at) ?? '',
      },
    });
  }

  return derived;
}

/**
 * Hang the gates on the runs and the nodes that the rest of the UI reads them from.
 *
 * - **`run.hasOpenGates`** raises the gate strip and flags the row in the rail. #16 landed it
 *   as `false`; this is where it becomes true.
 * - **`task.gate`** is the node's ⛔ marker (SPEC §7.5). A task can raise more than one gate, so
 *   the node shows **the one that is blocking it** — the oldest still open — and, when nothing
 *   is, the last one it answered, which is what #20's inspector reads to reconstruct the
 *   decision that was made.
 */
export function attachGates(runs: Run[], tasks: Task[], gates: Gate[]): { runs: Run[]; tasks: Task[] } {
  const ofTask = new Map<string, Gate[]>();
  const blockedRuns = new Set<string>();

  for (const gate of gates) {
    if (gate.taskId !== null) {
      const existing = ofTask.get(gate.taskId);
      if (existing) existing.push(gate);
      else ofTask.set(gate.taskId, [gate]);
    }
    if (gate.status === 'open' && gate.runId !== null) blockedRuns.add(gate.runId);
  }

  return {
    runs: runs.map((run) => (blockedRuns.has(run.id) ? { ...run, hasOpenGates: true } : run)),
    tasks: tasks.map((task) => {
      const held = ofTask.get(task.id);
      return held === undefined ? task : { ...task, gate: markerGate(held) };
    }),
  };
}

/** The gates arrive oldest-first, so the first open one is the one that has blocked longest. */
function markerGate(gates: Gate[]): Gate {
  return gates.find((gate) => gate.status === 'open') ?? gates[gates.length - 1]!;
}

/**
 * `(task_id, question)` — the pair the additive merge deduplicates on.
 *
 * Separated by NUL, which cannot occur in a task id or in a question. A printable separator
 * would let a task id ending in it collide with a question beginning with it, and a collision
 * here *drops* a real gate — which is the one thing an additive merge must never do.
 */
function keyOf(taskId: string | null, question: string): string {
  return `${taskId ?? ''}\u0000${question}`;
}

/**
 * The question, from the `payload` — and from the `subject` when the payload has none.
 *
 * The payload is where `orchestration.ask` puts it (SPEC §4.5). But **half the gate messages on
 * the live database carry no `payload.question` at all**: a worker escalating by hand with
 * `orchestration send --type decision_gate` writes `{taskId, dispatchId}` and puts the question
 * in the subject. Reading the payload alone would leave a blank question beside the ⛔ on half
 * of every real gate strip — the same silent-emptiness this whole ticket is about, one level
 * down. `subject` is NOT NULL in this schema, so there is always something honest to show.
 */
function questionOf(payload: unknown, subject: string | null): string {
  return text(field(payload, 'question')) ?? subject ?? '';
}

function field(payload: unknown, name: string): unknown {
  if (typeof payload !== 'object' || payload === null) return null;
  return (payload as Record<string, unknown>)[name];
}

/** The options, however they were written. Nothing enforces that they are strings — or an array. */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((option): option is string => typeof option === 'string');
}

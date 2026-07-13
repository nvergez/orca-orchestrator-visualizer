import type { DatabaseSync } from 'node:sqlite';
import { parsePayload, taskIdOf } from '../shared/payload.ts';
import type { Gate, Run, Task } from '../shared/types.ts';
import type { Attribution } from './attribution.ts';
import { type Columns, selectPresent, selectWhere, text } from './rows.ts';
import { GATE_MESSAGE_COLUMNS, hasColumn } from './schema.ts';
import { byInstant, isoInstant } from './time.ts';

/**
 * Decision gates — **the highest-value trap in the whole schema** (SPEC §4.2, trap 1; §4.5),
 * and the collision #45 found inside it.
 *
 * `orchestration.ask` writes a `decision_gate` **message** and **no `decision_gates` row**. The
 * live database has **53 gate messages against a near-empty table.** A gates-from-the-table
 * implementation renders nothing, forever, on real runs — and passes an unwitting test suite,
 * because a tidy fixture with gate rows makes it look correct. So:
 *
 * - **`messages WHERE type = 'decision_gate'` is the primary and required source.** The question
 *   and the options come from the `payload`.
 * - **One gate, two records** (#45). Orca's built-in `Coordinator` copies a worker's gate
 *   message into a `decision_gates` row keyed by the same `(task_id, question)` — and then
 *   writes the gate's whole lifecycle *to the row alone*, threading no reply on the message.
 *   A message and a row that share the key are therefore a **gate twin**, merged into one gate:
 *   identity, attribution, question and options stay the message's; **lifecycle status and
 *   resolution come from the row, which is authoritative whenever it exists.** A row with no
 *   twin is still added (never primary, always additive), so CLI-driven runs lose nothing.
 * - **Lifecycle state is not blocking effect** (CONTEXT.md, ADR 0002). `status` records what
 *   the database proves — `pending | resolved | timeout` from a row, `resolved` from a threaded
 *   reply, `unanswered` from silence — and never infers `timeout` from age or the absence of a
 *   reply, because `orchestration.ask` does not persist its timeout (SPEC §4.2, trap 9).
 *   `blocking` is derived separately, in `attachGates`, from *current* task state.
 * - **Where it belongs is `attribution.ts`'s question, not a new one.** `payload.taskId` names
 *   the task (21 of 53 live); without one, the gate attaches to its run through the same handle
 *   window every message uses, and to no node. A `taskId` naming a task a reset deleted is a
 *   broken link, not a broken gate — exactly as it is for a message (SPEC §4.2, trap 8).
 */

/** The `decision_gates` columns, read if the table has them. It usually has few *rows*. */
const GATE_ROW_COLUMNS = ['id', 'task_id', 'question', 'options', 'status', 'resolution', 'created_at'] as const;

/** What a gate message says. Read only from the columns the file really has (#21). */
const GATE_SELECT = ['id', 'payload', 'subject', 'from_handle', 'to_handle', 'created_at'] as const;

/** What an answer says: which gate it threads on, and what was decided. */
const REPLY_SELECT = ['id', 'thread_id', 'body'] as const;

/** A gate, and the `(task_id, question)` pair a twin's two records share. */
type Derived = { key: string; gate: Gate };

export function readGates(db: DatabaseSync, columns: Columns, attribution: Attribution): Gate[] {
  // The primary source, when the schema can answer at all. It is *required* — a build that
  // silently fell back to the table here would ship the trap. So when the columns are not
  // there the gates are degraded by name (`schema.ts`), and the table merge below still runs:
  // it can only add what the messages could not.
  const readable = GATE_MESSAGE_COLUMNS.every((column) => hasColumn(columns, column));
  const fromMessages = readable ? readGateMessages(db, columns, attribution) : [];

  const merged = [...fromMessages];
  // The oldest message wins the key: the Coordinator materializes its row when the question is
  // first asked, so a re-asked question enriches the record of the original asking.
  const byKey = new Map<string, Derived>();
  for (const derived of fromMessages) {
    if (!byKey.has(derived.key)) byKey.set(derived.key, derived);
  }

  for (const derived of readGateRows(db, columns, attribution)) {
    const twin = byKey.get(derived.key);
    if (twin !== undefined) {
      // The twin merge (#45). The message keeps the gate's identity and everything it alone
      // knows — attribution, options, who asked. The row keeps what *it* alone knows: the
      // authoritative lifecycle, and the resolution the Coordinator wrote nowhere else.
      // The pre-#45 build dropped the row here, and with it every resolution.
      twin.gate = { ...twin.gate, status: derived.gate.status, resolution: derived.gate.resolution };
      continue;
    }
    byKey.set(derived.key, derived);
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
        // A reply-less message proves only that no answer was recorded — never a timeout, and
        // never by itself a block: `orchestration.ask` returns `timedOut: true` without writing
        // that fact anywhere (SPEC §4.2, trap 9; #45).
        status: answer === null ? 'unanswered' : 'resolved',
        // False until `attachGates` has the tasks: blocking is a *present* effect derived from
        // current task state, which this module — handed only messages and rows — never sees.
        blocking: false,
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
 * The `decision_gates` rows — **authoritative when present, and never primary** (SPEC §4.5).
 *
 * A row carries no handles and no thread, so a row without a message twin can only be placed
 * through its task. Without one that still exists it lands in no run, and the strip — which is
 * run-scoped — never shows it. That is rule 3 again: a gate in the wrong run is a lie; a gate
 * in no run is a gap.
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
        status: rowStatus(text(row.status)),
        blocking: false, // Derived in `attachGates`, like every gate's — see above.
        resolution: text(row.resolution),
        createdAt: isoInstant(row.created_at) ?? '',
      },
    });
  }

  return derived;
}

/**
 * A row's status, kept as the distinct fact it is (#45): `resolved` and `timeout` are terminal,
 * and folding `timeout` into a blocking state is how timed-out probes kept whole runs "blocked"
 * for days. A status this build has never seen — a newer Orca's fifth state — degrades to
 * `unanswered`: blocking is conservative (SPEC §4.5), "work is paused" is not a claim this
 * build can prove from a word it does not know (a future *terminal* state read as pending
 * would resurrect the false-blocker bug on every such row), and `unanswered` claims nothing
 * beyond "no recorded answer" while the blocked-task cross-check still catches a real pause.
 */
function rowStatus(status: string | null): Gate['status'] {
  if (status === 'pending') return 'pending';
  if (status === 'resolved') return 'resolved';
  if (status === 'timeout') return 'timeout';
  return 'unanswered';
}

/**
 * Derive each gate's **present blocking effect**, and hang the gates on the runs and the nodes
 * the rest of the UI reads them from.
 *
 * - **`gate.blocking`** is the strip, the ⛔, the rail flag and every alert (SPEC §4.5, #45).
 *   Conservative by ruling: a table-backed `pending` gate blocks; `resolved` and `timeout` are
 *   terminal and never do; an `unanswered` ask blocks only while it names an existing task
 *   whose authoritative *current* `tasks.status` is `blocked`. Re-derived per tick — a task
 *   that moves on takes the blocker down with it, with no memory on the gate.
 * - **`run.hasBlockingGates`** raises the gate strip and flags the row in the rail. #16 landed
 *   it as `false`; this is where it becomes true.
 * - **`task.gate`** is the node's ⛔ marker (SPEC §7.5). A task can raise more than one gate, so
 *   the node shows **the one that is blocking it** — the oldest still blocking — and, when
 *   nothing is, the latest one, which is what #20's inspector reads as the task's history.
 */
export function attachGates(runs: Run[], tasks: Task[], gates: Gate[]): { runs: Run[]; tasks: Task[]; gates: Gate[] } {
  const statusOf = new Map(tasks.map((task) => [task.id, task.status]));
  const derived = gates.map((gate) => ({ ...gate, blocking: isBlocking(gate, statusOf) }));

  const ofTask = new Map<string, Gate[]>();
  const blockedRuns = new Set<string>();

  for (const gate of derived) {
    if (gate.taskId !== null) {
      const existing = ofTask.get(gate.taskId);
      if (existing) existing.push(gate);
      else ofTask.set(gate.taskId, [gate]);
    }
    if (gate.blocking && gate.runId !== null) blockedRuns.add(gate.runId);
  }

  return {
    runs: runs.map((run) => (blockedRuns.has(run.id) ? { ...run, hasBlockingGates: true } : run)),
    tasks: tasks.map((task) => {
      const held = ofTask.get(task.id);
      return held === undefined ? task : { ...task, gate: markerGate(held) };
    }),
    gates: derived,
  };
}

/** The blocking rule, whole and in one place (SPEC §4.5, #45). */
function isBlocking(gate: Gate, statusOf: Map<string, string>): boolean {
  if (gate.status === 'pending') return true;
  if (gate.status === 'unanswered') return gate.taskId !== null && statusOf.get(gate.taskId) === 'blocked';
  return false; // `resolved` and `timeout` are terminal.
}

/** The gates arrive oldest-first, so the first blocking one is the one that has blocked longest. */
function markerGate(gates: Gate[]): Gate {
  return gates.find((gate) => gate.blocking) ?? gates[gates.length - 1]!;
}

/**
 * `(task_id, question)` — the pair a gate twin's two records share, and the one the merge
 * matches on.
 *
 * Separated by NUL, which cannot occur in a task id or in a question. A printable separator
 * would let a task id ending in it collide with a question beginning with it, and a collision
 * here *merges* two real gates — which is the one thing this merge must never do.
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

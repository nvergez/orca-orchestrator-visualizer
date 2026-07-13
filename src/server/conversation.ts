import { receiptOfWorkerDone } from '../shared/receipt.ts';
import type { FeedMessage, Gate, ReceiptFact, Run, Turn } from '../shared/types.ts';
import type { TaskWithHandle } from './runs.ts';
import type { Preview } from './tasks.ts';
import { byInstant } from './time.ts';

/**
 * **The conversation — and the trap that makes or breaks this whole feature.**
 *
 * When the orchestrator dispatches an agent, **it writes no message.** Orca injects the prompt
 * straight into the worker's PTY, and the live database contains **zero** `type = 'dispatch'`
 * rows (SPEC §4.2, trap 2). So a conversation built from the `messages` table alone renders
 * agents talking into the void, to an orchestrator that never answers a word — half a dialogue,
 * and the half that makes no sense on its own.
 *
 * The other half is in the schema. It was just never called a conversation. **Four sources, merged
 * on one timeline** (SPEC §4.7):
 *
 * | Turn | Reconstructed from |
 * |---|---|
 * | The orchestrator's prompt | `tasks.spec`, timestamped by `dispatch_contexts.dispatched_at` |
 * | The agent answering | `messages` — `status`, `worker_done`, `escalation` |
 * | A question, and its answer | a `decision_gate` message, and the reply whose `thread_id` is its `id` |
 * | The final report | `tasks.result`, timestamped by `tasks.completed_at` |
 *
 * Everything downstream of this — the panel, the bubbles, which side of the dock they sit on — is
 * presentation. This is the feature.
 *
 * Four things it is careful about, and each of them is a trap the schema lays:
 *
 * - **Two timestamp formats meet here.** `dispatch_contexts.dispatched_at` is SQL-format and
 *   `tasks.completed_at` is ISO (SPEC §4.2, trap 5) — this merge orders columns written by *both*
 *   writers against each other, which is precisely where an unnormalized comparison silently
 *   produces garbage. Every instant it touches has already been through `isoInstant` at the query
 *   layer, and it compares them through `byInstant`, which sorts an unreadable one last rather
 *   than pretending it is the epoch.
 *
 * - **Every join tolerates a miss.** There are no foreign keys (SPEC §4.2, trap 8). A message
 *   pointing at a task an `orchestration reset` deleted still becomes a turn — it just carries no
 *   `taskId`. A gate message whose `Gate` could not be derived still speaks: the question falls
 *   back to what the row actually holds.
 *
 * - **One `dispatch` turn per *attempt*, not per task.** `dispatch_contexts` is one row per
 *   attempt, and a retry is a genuinely separate thing the orchestrator did — to a fresh worktree,
 *   with a fresh handle. Folding them into one turn would hide the only retry story the schema
 *   has.
 *
 * - **Heartbeats are 65% of all traffic** (302 of 466 — SPEC §4.2, trap 4) and every one of them
 *   says "alive". Rendered straight they bury the conversation in a ticker. They collapse to **one
 *   row per task**, which keeps the fact (an agent was beating, this often, over this span) and
 *   throws away only the repetition.
 *
 * Pure — turns in, turns out, no SQLite. The scoping the panels do (one orchestrator, one agent,
 * one task) is a filter over `runId`, the agent side of the turn and `taskId`, and it lives with the
 * panel that does it (`client/conversation/select.ts`), asserted against a real snapshot of this.
 */

export type ConversationSources = {
  /** Every task, with its run, its attempts, and the previews of its spec and result. */
  entries: TaskWithHandle[];
  /** The runs, for the coordinator handle and the cast of each. */
  runs: Run[];
  /** Every gate, already derived from the `decision_gate` messages that raise them (`gates.ts`). */
  gates: Gate[];
  /** **Every** message — not the delta. A conversation is a whole thing or it is a fragment. */
  messages: FeedMessage[];
};

/** The two kinds this tool reconstructs out of columns no message was ever written for. */
const DISPATCH = 'dispatch';
const RESULT = 'result';
/** The reply that closed a gate — an ordinary message, and the only one worth its own word. */
const ANSWER = 'answer';
/** The 302 beats, standing in one row per task. */
const HEARTBEATS = 'heartbeats';

const HEARTBEAT = 'heartbeat';
const DECISION_GATE = 'decision_gate';
const WORKER_DONE = 'worker_done';

/**
 * How much of a receipt a turn gets (#67) — the fact-count sibling of `BODY_PREVIEW_CHARS`,
 * and for the same reason: the conversation rides a snapshot that is re-sent whole every five
 * seconds, and a worker that modified four hundred files must not put four hundred chips on
 * it. The inspector carries the whole receipt, merged across both sources.
 */
export const RECEIPT_PREVIEW_FACTS = 8;

/**
 * The compact summary, spelled the way every optional turn field is: **absent when it has
 * nothing to say** (SPEC §6.3). A prose result and a bookkeeping-only payload are the common
 * case, and 360 turns saying `"receipt":[]` five seconds apart is kilobytes of nothing.
 */
function compactReceipt(facts: ReceiptFact[]): { receipt?: ReceiptFact[]; receiptOmitted?: number } {
  if (facts.length === 0) return {};
  if (facts.length <= RECEIPT_PREVIEW_FACTS) return { receipt: facts };
  return { receipt: facts.slice(0, RECEIPT_PREVIEW_FACTS), receiptOmitted: facts.length - RECEIPT_PREVIEW_FACTS };
}

export function conversationOf({ entries, runs, gates, messages }: ConversationSources): Turn[] {
  const cast = castIndex(runs);
  const gateOfMessage = new Map(gates.filter((gate) => gate.messageId !== null).map((gate) => [gate.messageId!, gate]));

  const turns: Turn[] = [
    ...dispatchTurns(entries, cast),
    ...resultTurns(entries, cast),
    ...messageTurns(messages, cast, gateOfMessage),
  ];

  return turns.sort(byTimeline);
}

/**
 * Who is an agent, and who is the orchestrator — the one question every turn has to answer before
 * it knows which way it points.
 */
type Cast = {
  /** A run's agent handles. The cast, as a membership test. */
  agentsOf: Map<string, ReadonlySet<string>>;
  /** Every agent handle in the database, for a message no run could claim (SPEC §4.4, rule 3). */
  anywhere: ReadonlySet<string>;
};

function castIndex(runs: Run[]): Cast {
  const agentsOf = new Map<string, ReadonlySet<string>>();
  const anywhere = new Set<string>();

  for (const run of runs) {
    const handles = run.cast.map((member) => member.handle);
    agentsOf.set(run.id, new Set(handles));
    for (const handle of handles) anywhere.add(handle);
  }

  return { agentsOf, anywhere };
}

/**
 * **`out` is the orchestrator; `in` is an agent** — and the test is "did an agent say it?", never
 * "is the sender the coordinator".
 *
 * The synthetic `run_unattributed` has no coordinator handle at all — those tasks are in it
 * *because* Orca never recorded who created them — so a rule that keyed on the coordinator would
 * leave every one of its turns pointing nowhere. Asking the cast instead answers for both.
 *
 * A message no run could claim falls back to "is this an agent *anywhere*", which is the most the
 * schema can honestly say about it.
 */
function directionOf(runId: string | null, fromHandle: string | null, { agentsOf, anywhere }: Cast): 'in' | 'out' {
  if (fromHandle === null || fromHandle === '') return 'out';

  const agents = runId === null ? anywhere : (agentsOf.get(runId) ?? anywhere);
  return agents.has(fromHandle) ? 'in' : 'out';
}

/**
 * **The orchestrator's half of the dialogue — the turns no message exists for.**
 *
 * One per dispatch *attempt*: `tasks.spec` is what was said, and `dispatch_contexts.dispatched_at`
 * is when. Nothing else in the schema records either fact, which is why a conversation read out of
 * `messages` alone has an orchestrator that never speaks.
 *
 * A task with no `spec` still produces the turn. The dispatch **happened** — the row is right
 * there — and a silent gap where an agent was plainly sent to work would be a worse account of it
 * than a turn that says the prompt is not in the file. (Pre-`spec` Orcas do not exist, but a
 * column can always be dropped, and `meta.degraded` names this exact loss — `schema.ts`.)
 */
function dispatchTurns(entries: TaskWithHandle[], cast: Cast): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    const coordinator = entry.handle;

    entry.attempts.forEach((attempt, index) => {
      const toHandle = attempt.assigneeHandle === '' ? null : attempt.assigneeHandle;
      const direction = directionOf(entry.task.runId, coordinator, cast);

      turns.push({
        id: `dispatch:${attempt.id}`,
        runId: entry.task.runId,
        direction,
        kind: DISPATCH,
        fromHandle: coordinator,
        toHandle,
        at: attempt.dispatchedAt,
        taskId: entry.task.id,
        subject: entry.task.title,
        ...bodyOf(entry.spec, 'no spec on this task — the prompt is not in the database'),
        // The whole point of the caption. A bubble that looked like a message the orchestrator
        // sent, when no such message was ever written, would be the most convincing lie this tool
        // could tell — so it says which two columns it was built out of, on screen.
        source:
          entry.attempts.length > 1
            ? `tasks.spec · dispatch_contexts.dispatched_at · attempt ${index + 1} of ${entry.attempts.length}`
            : 'tasks.spec · dispatch_contexts.dispatched_at',
      });
    });
  }

  return turns;
}

/**
 * **The final report** — `tasks.result`, at `tasks.completed_at`.
 *
 * Also not a message. A `worker_done` message usually announces it, but the *receipt* — what the
 * agent actually handed back — is a column, and it is the last thing anybody says in a task's
 * story.
 *
 * `tasks.completed_at` is the ISO-format column and `dispatched_at` beside it is the SQL one
 * (SPEC §4.2, trap 5). This is the exact comparison that trap exists to break, and it does not,
 * because both went through `isoInstant` before they got here.
 */
function resultTurns(entries: TaskWithHandle[], cast: Cast): Turn[] {
  const turns: Turn[] = [];

  for (const entry of entries) {
    if (entry.result === null) continue;

    const latest = entry.task.dispatch;
    const fromHandle = latest && latest.assigneeHandle !== '' ? latest.assigneeHandle : null;
    const direction = directionOf(entry.task.runId, fromHandle, cast);

    turns.push({
      id: `result:${entry.task.id}`,
      runId: entry.task.runId,
      direction,
      kind: RESULT,
      fromHandle,
      toHandle: entry.handle,
      // A result with no completion instant sorts to the end rather than to 1970 (`byInstant`):
      // `COALESCE(new, old)` means a re-completion overwrites the time (SPEC §4.2, trap 7), and a
      // task can carry a result with the column never filled in. The dispatch's own completion is
      // the closest thing the schema has to when it came back.
      at: entry.task.completedAt ?? latest?.completedAt ?? '',
      taskId: entry.task.id,
      subject: entry.task.title,
      ...bodyOf(entry.result, ''),
      // What the body's (often truncated) JSON actually says, as facts (#67): the receipt is
      // read from the whole column, so it survives the preview that cut the body above.
      ...compactReceipt(entry.resultReceipt),
      source: 'tasks.result · tasks.completed_at',
    });
  }

  return turns;
}

/**
 * **The agents' half** — and the one place the `messages` table really is the source.
 *
 * Three shapes come out of it, and only one of them is ordinary:
 *
 * - A **`decision_gate`** carries the question and its options, and says whether it was ever
 *   answered. All of that is `gates.ts`'s already — derived from the message, with the question
 *   falling back to the `subject` for the half of real gates that carry no `payload.question`.
 *   Re-deriving it here would be a second implementation of the schema's highest-value trap.
 * - The **reply that threads on a gate** is the orchestrator answering, and it is the only message
 *   in this schema that is a *response* to another one. It gets its own word, so the panel can put
 *   the question and the answer together.
 * - **Heartbeats** collapse. Everything else is itself, under its own `type`, verbatim — including
 *   a type an Orca we have never seen invents (SPEC §5).
 */
function messageTurns(messages: FeedMessage[], cast: Cast, gateOfMessage: Map<string, Gate>): Turn[] {
  const turns: Turn[] = [];
  const beats: FeedMessage[] = [];

  for (const message of messages) {
    if (message.type === HEARTBEAT) {
      beats.push(message);
      continue;
    }

    const direction = directionOf(message.runId, message.fromHandle, cast);
    const from = message.fromHandle === '' ? null : message.fromHandle;
    const to = message.toHandle === '' ? null : message.toHandle;

    const gate = message.type === DECISION_GATE ? (gateOfMessage.get(message.id) ?? null) : null;
    // A message cannot answer itself. Orca threads a reply on the *outbound* id, so a row whose
    // thread is its own id opened a thread rather than closing one (`gates.ts` guards the same).
    const answers =
      message.threadId !== null && message.threadId !== message.id && gateOfMessage.has(message.threadId);

    turns.push({
      id: `msg:${message.sequence}`,
      runId: message.runId,
      direction,
      kind: answers ? ANSWER : message.type,
      fromHandle: from,
      toHandle: to,
      at: message.createdAt,
      taskId: message.taskId,
      subject: message.subject,
      // A gate's question is the gate's — payload first, subject second, which is what makes half
      // the real gate strip non-blank (`gates.ts`). Everything else says what its body says, and
      // falls back to its subject when the body is empty, because a bubble with nothing in it is
      // a message the panel has failed to render rather than a message with nothing to say.
      body: gate ? gate.question : message.body !== '' ? message.body : message.subject,
      ...(gate && gate.options.length > 0 && { options: gate.options }),
      // The recorded decision, wherever it was recorded: the threaded reply, or — for a
      // Coordinator gate twin — the `decision_gates` row the resolution was written to (#45).
      ...(gate?.status === 'resolved' && gate.resolution !== null && { answer: gate.resolution }),
      // The two separate gate facts (#45): the recorded lifecycle, and whether it is blocking
      // *now* — which is what decides "blocking — waiting" against "no answer recorded" on
      // screen. `blocking` is only ever said when true (`Turn`).
      ...(gate && { gateStatus: gate.status }),
      ...(gate?.blocking && { blocking: true }),
      // A worker's completion payload is the other place an outcome receipt lives (#67) —
      // the body above is its prose summary; these are its recognized facts.
      ...(message.type === WORKER_DONE ? compactReceipt(receiptOfWorkerDone(message.payload)) : {}),
      source: answers
        ? `messages.thread_id = the gate's id · #${message.sequence}`
        : `messages · #${message.sequence}`,
    });
  }

  return [...turns, ...heartbeatTurns(beats, cast)];
}

/**
 * **302 of 466 messages, in as many rows as they are worth: one per task.**
 *
 * A heartbeat says "alive", every five minutes, and its value is *liveness* rather than
 * event-ness — which already reached the screen as the agent's "last seen 12s ago" badge (SPEC
 * §4.6). Rendered straight, they turn a conversation into a ticker with the real exchange lost
 * inside it.
 *
 * They collapse **by task**, not by adjacency, and that is what makes the summary survive the
 * scoping: a task belongs to exactly one agent-and-run, so one row per task is a row that is
 * wholly inside every scope the panel can ask for — the orchestrator's, the agent's, and the
 * task's. A summary collapsed by adjacency in the *global* order would straddle those boundaries
 * and count beats the reader cannot see.
 *
 * A beat naming no task — which the live database has none of, but no foreign key forbids —
 * collapses by the pair of terminals that exchanged it instead of being dropped.
 */
function heartbeatTurns(beats: FeedMessage[], cast: Cast): Turn[] {
  const groups = new Map<string, FeedMessage[]>();

  for (const beat of beats) {
    const key = beat.taskId ?? `${beat.fromHandle} ${beat.toHandle}`;
    const group = groups.get(key);
    if (group) group.push(beat);
    else groups.set(key, [beat]);
  }

  return [...groups].map(([key, group]): Turn => {
    const ordered = [...group].sort((a, b) => byInstant(a.createdAt, b.createdAt));
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;

    const direction = directionOf(first.runId, first.fromHandle, cast);
    const from = first.fromHandle === '' ? null : first.fromHandle;
    const to = first.toHandle === '' ? null : first.toHandle;

    return {
      id: `beats:${key}`,
      runId: first.runId,
      direction,
      kind: HEARTBEATS,
      fromHandle: from,
      toHandle: to,
      // Where the beating *started*, so the row sits at the moment the agent went to work rather
      // than at the moment it stopped.
      at: first.createdAt,
      taskId: first.taskId,
      subject: 'heartbeats',
      body: '',
      beatCount: ordered.length,
      // The span, so the panel can say "every ~5 min" out of two instants and a count instead of
      // asserting a cadence nobody measured.
      endedAt: last.createdAt,
      source: "messages · type = 'heartbeat'",
    };
  });
}

/** A body, or an honest sentence about why there is none. Never an empty bubble. */
function bodyOf(preview: Preview | null, absent: string): { body: string; truncated?: boolean } {
  if (preview === null) return { body: absent };
  return preview.truncated ? { body: preview.text, truncated: true } : { body: preview.text };
}

/**
 * One timeline, out of columns two different writers wrote.
 *
 * The tie-break is not decoration. A `dispatch` and the first `status` about it routinely land in
 * the same second, and so do a `result` and the `worker_done` that announces it — so the bookends
 * of a task's life are pinned: **the dispatch opens, the result closes**, and everything else
 * falls between them in the order the log recorded it. The id breaks the last tie, so two polls of
 * an unchanged database cannot render the same conversation in two orders.
 */
function byTimeline(a: Turn, b: Turn): number {
  return byInstant(a.at, b.at) || rankOf(a.kind) - rankOf(b.kind) || a.id.localeCompare(b.id);
}

function rankOf(kind: string): number {
  if (kind === DISPATCH) return 0;
  if (kind === RESULT) return 2;
  return 1;
}

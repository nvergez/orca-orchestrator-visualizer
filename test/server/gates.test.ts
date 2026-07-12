import { afterEach, describe, expect, it } from 'vitest';
import type { Gate } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **The highest-value trap in the map** (SPEC §4.2, trap 1; #19) — and the collision #45 found
 * inside it.
 *
 * `orchestration.ask` writes a `decision_gate` **message** and **no `decision_gates` row**.
 * The live database has 53 gate messages against a near-empty table — so a gates-from-the-table
 * implementation renders nothing, forever, on real runs *and passes an unwitting test suite*.
 * Messages therefore stay the primary source, and most fixtures below carry zero gate rows.
 *
 * But Orca's built-in Coordinator writes **both** records for one gate: the worker's message
 * carries the question, the Coordinator materializes a row with the same `(task_id, question)`,
 * and resolution is written *only to the row*. A merge that discarded the matching row (as the
 * pre-#45 build did) lost the authoritative resolution and left the run blocked on screen
 * forever. So: one gate, two records — identity from the message, lifecycle from the row.
 *
 * Lifecycle state is not blocking effect (CONTEXT.md, ADR 0001). `status` is one of four facts
 * the database can actually prove — `pending | resolved | timeout | unanswered` — and
 * `blocking` is a separate, conservative claim: a pending row blocks; terminal states do not;
 * an unanswered ask blocks only while it names an existing task whose current status is
 * `blocked`, because `orchestration.ask` never persists its timeout and a reply-less message
 * proves only that no answer was recorded.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const at = (minutes: number) => new Date(AT.getTime() + minutes * 60_000);

const COORDINATOR = handleFor('coordinator');
const WORKER = handleFor('worker');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** One task, worked by one worker — the smallest orchestration a gate can affect. */
function orchestration(taskStatus = 'dispatched'): FixtureBuilder {
  const builder = new FixtureBuilder();
  builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', status: taskStatus, createdAt: AT });
  builder.dispatch({ taskId: 'task_a', assigneeHandle: WORKER, status: 'dispatched', dispatchedAt: at(1) });
  return builder;
}

/** A `decision_gate` message — the primary source, and often a gate's only record. */
function asks(builder: FixtureBuilder, over: { id: string; taskId?: string; question?: string; at?: number }): void {
  builder.message({
    id: over.id,
    type: 'decision_gate',
    fromHandle: WORKER,
    toHandle: COORDINATOR,
    subject: 'Decision needed',
    body: 'The worker cannot proceed.',
    payload: {
      question: over.question ?? 'Which driver?',
      options: ['node:sqlite', 'better-sqlite3'],
      ...(over.taskId ? { taskId: over.taskId } : {}),
    },
    createdAt: at(over.at ?? 5),
  });
}

/** The answer. It threads on the gate *message's* id — that is what resolves a message-only gate. */
function answers(builder: FixtureBuilder, gateId: string, body: string, minutes = 9): void {
  builder.message({
    type: 'status',
    fromHandle: COORDINATOR,
    toHandle: WORKER,
    subject: 'Re: decision',
    body,
    threadId: gateId,
    createdAt: at(minutes),
  });
}

async function gatesOf(builder: FixtureBuilder): Promise<Gate[]> {
  harness = await serve(builder.write(tempDbPath()));
  return (await harness.snapshot()).snapshot.gates;
}

describe('gates, derived from decision_gate messages', () => {
  it('finds them in a database with gate messages and zero decision_gates rows', async () => {
    // The real CLI shape, and still the whole point: the table this data "belongs" in is empty.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    const gates = await gatesOf(builder);

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      messageId: 'msg_gate',
      taskId: 'task_a',
      question: 'Which driver?',
      options: ['node:sqlite', 'better-sqlite3'],
      status: 'unanswered',
    });
  });

  it('reports a reply-less ask as unanswered and non-blocking — no run flag, no ⛔, still on the node as history', async () => {
    // `orchestration.ask` returns `timedOut: true` without writing that fact, so a reply-less
    // message proves only that no answer was recorded — never that the orchestration is still
    // waiting (SPEC §4.2, trap 9; #45). The task here is `dispatched`: work is moving, and a
    // strip raised over it would be the false-blocker bug this issue is.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({ status: 'unanswered', blocking: false, resolution: null });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
    // The question is still the task's history — the inspector keeps it, truthfully worded.
    expect(snapshot.tasks[0]!.gate).toMatchObject({ status: 'unanswered', blocking: false });
  });

  it('marks an unanswered ask blocking while it names an existing task whose current status is blocked', async () => {
    // The cross-check (SPEC §4.5): `tasks.status = 'blocked'` is current, authoritative state —
    // the one durable proof that a reply-less question is really holding work up.
    const builder = orchestration('blocked');
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({ status: 'unanswered', blocking: true });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(true);
    expect(snapshot.tasks[0]!.gate).toMatchObject({ blocking: true });
  });

  it('stops calling it blocking the moment the task moves on', async () => {
    // Same records, different task state: blocking is a *present* effect, re-derived per tick,
    // never a property the gate keeps.
    const builder = orchestration('completed');
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({ status: 'unanswered', blocking: false });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
  });

  it('is resolved by a reply threading on the gate message id, and the reply body is the resolution', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });
    answers(builder, 'msg_gate', 'node:sqlite — zero native deps');

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({
      status: 'resolved',
      blocking: false,
      resolution: 'node:sqlite — zero native deps',
    });
    // An answered question blocks nothing: no strip, no rail flag, no ⛔ on the node.
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
    expect(snapshot.tasks[0]!.gate).toMatchObject({ status: 'resolved' });
  });

  it('does not mistake a reply to another gate for an answer to this one', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate_1', taskId: 'task_a', question: 'Which driver?', at: 5 });
    asks(builder, { id: 'msg_gate_2', taskId: 'task_a', question: 'Which transport?', at: 6 });
    answers(builder, 'msg_gate_1', 'node:sqlite');

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => [gate.question, gate.status])).toEqual([
      ['Which driver?', 'resolved'],
      ['Which transport?', 'unanswered'],
    ]);
  });

  it('attaches a gate with no payload.taskId to its run and to no node — visible, and never blocking', async () => {
    // 32 of the 53 live gate messages name no task. Without one there is no current task state
    // to prove a block, so the gate stays in the run's history and raises nothing (#45) — the
    // live database's stale "ping: can you read this?" probes are exactly this shape.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({ taskId: null, blocking: false, status: 'unanswered' });
    expect(snapshot.gates[0]!.runId).toBe(snapshot.runs[0]!.id);
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
    expect(snapshot.tasks[0]!.gate).toBeNull();
  });

  it('keeps a gate whose taskId names a task a reset deleted — unlinked, non-blocking, never dropped', async () => {
    // No foreign keys anywhere in this schema (SPEC §4.2, trap 8). A dangling reference costs
    // the gate its node and its claim to block, not its place on screen.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_wiped_by_a_reset' });

    const gates = await gatesOf(builder);

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ taskId: null, blocking: false });
  });

  it('takes the question and the options from the payload', async () => {
    const builder = orchestration();
    builder.message({
      id: 'msg_gate',
      type: 'decision_gate',
      fromHandle: WORKER,
      toHandle: COORDINATOR,
      subject: 'Decision needed',
      payload: { taskId: 'task_a', question: 'Merge or rebase?', options: ['merge', 'rebase', 'squash'] },
      createdAt: at(5),
    });

    const gates = await gatesOf(builder);

    expect(gates[0]!.question).toBe('Merge or rebase?');
    expect(gates[0]!.options).toEqual(['merge', 'rebase', 'squash']);
  });

  it('falls back to the subject when a raw decision_gate message carries no payload question', async () => {
    // `orchestration.ask` writes {question, options}; a worker escalating by hand with
    // `orchestration send --type decision_gate` writes a subject and no payload at all. An
    // empty question over a real blocker would be the panel saying nothing (SPEC §5).
    const builder = orchestration();
    builder.message({
      id: 'msg_gate',
      type: 'decision_gate',
      fromHandle: WORKER,
      toHandle: COORDINATOR,
      subject: 'Blocked: which base branch?',
      body: 'main or the integration branch?',
      payload: { taskId: 'task_a' },
      createdAt: at(5),
    });

    const gates = await gatesOf(builder);

    expect(gates[0]).toMatchObject({ question: 'Blocked: which base branch?', options: [], status: 'unanswered' });
  });

  it('normalizes the gate timestamp to an ISO instant, like every other one', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a', at: 5 });

    const gates = await gatesOf(builder);

    expect(gates[0]!.createdAt).toBe(at(5).toISOString());
  });

  it('carries the blocking gate to the node even when the task has an answered one too', async () => {
    // The ⛔ marker is about what is *blocking*. A task that has already answered one question
    // and is stuck on the next must show the one it is stuck on.
    const builder = orchestration('blocked');
    asks(builder, { id: 'msg_gate_1', taskId: 'task_a', question: 'Answered', at: 5 });
    answers(builder, 'msg_gate_1', 'yes');
    asks(builder, { id: 'msg_gate_2', taskId: 'task_a', question: 'Still blocking', at: 7 });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.tasks[0]!.gate).toMatchObject({ question: 'Still blocking', status: 'unanswered', blocking: true });
  });

  it('prefers the oldest blocking gate for the marker, and the latest gate when nothing blocks', async () => {
    // Two questions holding one task: the node names the one that has blocked longest. When the
    // task moves on, nothing blocks — and the marker keeps the *latest* question as the task's
    // history for the inspector (SPEC §6.3, `Task.gate`).
    const blocked = orchestration('blocked');
    asks(blocked, { id: 'msg_gate_1', taskId: 'task_a', question: 'Asked first', at: 5 });
    asks(blocked, { id: 'msg_gate_2', taskId: 'task_a', question: 'Asked second', at: 7 });

    harness = await serve(blocked.write(tempDbPath()));
    expect((await harness.snapshot()).snapshot.tasks[0]!.gate).toMatchObject({ question: 'Asked first', blocking: true });
    await harness.close();

    const moved = orchestration('completed');
    asks(moved, { id: 'msg_gate_1', taskId: 'task_a', question: 'Asked first', at: 5 });
    asks(moved, { id: 'msg_gate_2', taskId: 'task_a', question: 'Asked second', at: 7 });

    harness = await serve(moved.write(tempDbPath()));
    expect((await harness.snapshot()).snapshot.tasks[0]!.gate).toMatchObject({ question: 'Asked second', blocking: false });
  });
});

/**
 * **One gate, two records** (SPEC §4.5, #45). Orca's built-in Coordinator copies the worker's
 * message into a `decision_gates` row keyed by the same `(task_id, question)`, and then writes
 * the gate's whole lifecycle — `pending`, `resolved`, `timeout`, the resolution text — to the
 * row alone, threading no reply on the message. The merge keeps the message's identity and
 * context and takes lifecycle from the row: discarding either record loses half the gate.
 */
describe('a Coordinator gate twin — a message and a table row for one question', () => {
  /** The Coordinator's row: same `(task_id, question)` as the message the worker sent. */
  function materializes(builder: FixtureBuilder, over: { status: string; resolution?: string | null; question?: string }): void {
    builder.gate({
      taskId: 'task_a',
      question: over.question ?? 'Which driver?',
      options: [],
      status: over.status,
      resolution: over.resolution ?? null,
      createdAt: at(6),
    });
  }

  it('merges the twin into one gate: identity and context from the message, resolution from the row', async () => {
    // **The #45 regression.** The pre-#45 merge read the message first, marked it open, and
    // skipped the row — so the Coordinator's resolution, written only to the row, was lost and
    // the run stayed blocked on screen forever.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });
    materializes(builder, { status: 'resolved', resolution: 'node:sqlite' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates).toHaveLength(1);
    expect(snapshot.gates[0]).toMatchObject({
      id: 'msg_gate',
      messageId: 'msg_gate',
      taskId: 'task_a',
      question: 'Which driver?',
      options: ['node:sqlite', 'better-sqlite3'], // the message's — the row wrote none
      status: 'resolved',
      resolution: 'node:sqlite',
      blocking: false,
    });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
    expect(snapshot.tasks[0]!.gate).toMatchObject({ status: 'resolved', resolution: 'node:sqlite' });
  });

  it('keeps a pending twin blocking — the row is durable proof the work is paused', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });
    materializes(builder, { status: 'pending' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates).toHaveLength(1);
    expect(snapshot.gates[0]).toMatchObject({ status: 'pending', blocking: true, resolution: null });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(true);
    expect(snapshot.tasks[0]!.gate).toMatchObject({ status: 'pending', blocking: true });
  });

  it('keeps a timeout twin as its own terminal state — never open, never blocking', async () => {
    // The row is the only place a timeout is ever persisted (SPEC §4.2, trap 9). Folding it
    // into a blocking state is how timed-out probes kept runs "blocked" for days.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });
    materializes(builder, { status: 'timeout' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({ status: 'timeout', blocking: false, resolution: null });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
  });

  it('takes the resolution from the row even when a reply also threaded on the message', async () => {
    // The row is authoritative when it exists (SPEC §4.5): the Coordinator writes the decision
    // there, and a threaded message is at best a copy of it.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });
    answers(builder, 'msg_gate', 'the threaded copy');
    materializes(builder, { status: 'resolved', resolution: 'the authoritative row' });

    const gates = await gatesOf(builder);

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({ status: 'resolved', resolution: 'the authoritative row' });
  });
});

/**
 * The `decision_gates` table without a matching message — still additive (SPEC §4.5): a row
 * this tool has no message for is a gate it would otherwise never show, and CLI-driven runs
 * that never write rows lose nothing.
 */
describe('the decision_gates table, merged in additively', () => {
  it('adds a gate that exists only as a table row', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a', question: 'From a message' });
    builder.gate({ taskId: 'task_a', question: 'From a row', options: ['a', 'b'], createdAt: at(6) });

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => gate.question)).toEqual(['From a message', 'From a row']);
    expect(gates[1]).toMatchObject({ messageId: null, taskId: 'task_a', options: ['a', 'b'], status: 'pending' });
  });

  it('keeps a row that asks the same question of a different task', async () => {
    const builder = orchestration();
    builder.task({ id: 'task_b', handle: COORDINATOR, title: 'The other thing', createdAt: at(2) });
    asks(builder, { id: 'msg_gate', taskId: 'task_a', question: 'Which driver?' });
    builder.gate({ taskId: 'task_b', question: 'Which driver?', createdAt: at(6) });

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => gate.taskId)).toEqual(['task_a', 'task_b']);
  });

  it('reads each of the three row states as itself, and only pending as blocking', async () => {
    const builder = orchestration();
    builder.gate({ taskId: 'task_a', question: 'Answered in the table', status: 'resolved', resolution: 'yes', createdAt: at(5) });
    builder.gate({ taskId: 'task_a', question: 'Timed out', status: 'timeout', createdAt: at(6) });
    builder.gate({ taskId: 'task_a', question: 'Pending', status: 'pending', createdAt: at(7) });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates.map((gate) => [gate.question, gate.status, gate.blocking, gate.resolution])).toEqual([
      ['Answered in the table', 'resolved', false, 'yes'],
      ['Timed out', 'timeout', false, null],
      ['Pending', 'pending', true, null],
    ]);
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(true);
  });

  it('treats a row status it has never seen as pending — unknown is not proof the gate is settled', async () => {
    // A newer Orca could add a fifth state (its CHECK constraint is that Orca's, not ours —
    // hence `allowUnknownEnums`). Terminal is a claim this build cannot verify for a word it
    // does not know, and a row exists only because a gate was really raised — so an unknown
    // status degrades to the table's one non-terminal state rather than to silence.
    const builder = new FixtureBuilder({ allowUnknownEnums: true });
    builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
    builder.gate({ taskId: 'task_a', question: 'From the future', status: 'escalated', createdAt: at(5) });

    const gates = await gatesOf(builder);

    expect(gates[0]).toMatchObject({ status: 'pending', blocking: true });
  });

  it('leaves a row whose task no longer exists attached to no run — never guessed into one', async () => {
    // A table row carries no handles and no window: without its task, nothing in the schema
    // says which orchestration it belonged to (SPEC §4.4, rule 3).
    const builder = orchestration();
    builder.gate({ taskId: 'task_wiped_by_a_reset', question: 'Orphaned', createdAt: at(5) });

    const gates = await gatesOf(builder);

    expect(gates[0]).toMatchObject({ taskId: null, runId: null });
  });
});

describe('gates in the live-shape corpus', () => {
  it('renders all 53 of them, from messages, against zero gate rows', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { snapshot } = await harness.snapshot();
    const gates = snapshot.gates;

    expect(gates).toHaveLength(53);
    // 21 of 53 name a task; 13 were never answered (test/fixtures/corpus.test.ts pins both).
    expect(gates.filter((gate) => gate.taskId !== null)).toHaveLength(21);
    expect(gates.filter((gate) => gate.status === 'unanswered')).toHaveLength(13);
    expect(gates.filter((gate) => gate.status === 'resolved')).toHaveLength(40);
    // Every one of them landed in a run, so every one of them can reach the strip.
    expect(gates.filter((gate) => gate.runId === null)).toHaveLength(0);
  });

  it('reads a question for every one of them, in each of the shapes the real database writes', async () => {
    // The trap inside the trap. Half the live database's gate messages carry no
    // `payload.question` — they are hand-written escalations that put the question in the
    // subject (test/fixtures/corpus.test.ts tallies all the shapes). A reader that takes the
    // question from the payload alone renders a strip full of ⛔ with nothing written beside it.
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { gates } = (await harness.snapshot()).snapshot;

    expect(gates.filter((gate) => gate.question === '')).toHaveLength(0);
    // …and the 15 whose question is only in the subject are read as fully as the rest.
    expect(gates.filter((gate) => /^Question \d+:/.test(gate.question))).toHaveLength(53);
  });

  it('raises no blocker anywhere — 13 stale unanswered asks, and not one blocked task among them', async () => {
    // The live database's own indictment (#45): 13 reply-less questions, several of them
    // connectivity probes on runs that ended days ago, and not a single task actually
    // `blocked`. The old build flagged 4 runs over them; the truthful answer is none.
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates.filter((gate) => gate.blocking)).toHaveLength(0);
    expect(snapshot.runs.filter((run) => run.hasBlockingGates)).toHaveLength(0);
    expect(snapshot.tasks.filter((task) => task.gate?.blocking)).toHaveLength(0);
    // …while every unanswered question is still on its node for the inspector to tell.
    expect(snapshot.tasks.filter((task) => task.gate !== null).length).toBeGreaterThan(0);
  });
});

describe('an Orca whose schema cannot answer the question', () => {
  it('degrades the gates rather than reporting every gate unanswered forever', async () => {
    // With no `thread_id` there is no way to tell an answered gate from an unanswered one, and
    // a history of 53 questions all labelled "no answer recorded" when every one was answered
    // days ago is worse than no history. So the feature degrades, by name (#21).
    const builder = new FixtureBuilder({ omitColumns: { messages: ['thread_id'] } });
    builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    harness = await serve(builder.write(tempDbPath()));
    const { meta, snapshot } = await harness.snapshot();

    expect(snapshot.gates).toEqual([]);
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
    expect(meta.degraded.join('\n')).toMatch(/[Dd]ecision gates .*thread_id/s);
  });

  it('keeps the gates when there is no payload column, and costs them only what it really costs', async () => {
    // Per-feature degradation (#21): a missing column disables exactly the feature that needs
    // it and nothing else. Without `payload` a gate loses its options and the node it marks —
    // it does *not* lose its question, which half the live database keeps in the subject anyway.
    // And with no task to name, an unanswered ask has nothing to prove a block with (#45).
    const builder = new FixtureBuilder({ omitColumns: { messages: ['payload'] } });
    builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
    builder.dispatch({ taskId: 'task_a', assigneeHandle: WORKER, status: 'dispatched', dispatchedAt: at(1) });
    builder.message({
      id: 'msg_gate',
      type: 'decision_gate',
      fromHandle: WORKER,
      toHandle: COORDINATOR,
      subject: 'Blocked: which base branch?',
      payload: { taskId: 'task_a', question: 'never read — the column is gone' },
      createdAt: at(5),
    });

    harness = await serve(builder.write(tempDbPath()));
    const { meta, snapshot } = await harness.snapshot();

    expect(snapshot.gates).toHaveLength(1);
    expect(snapshot.gates[0]).toMatchObject({
      question: 'Blocked: which base branch?',
      options: [],
      taskId: null, // No payload, no `taskId`: it stays in the run's history, and marks no node.
      status: 'unanswered',
      blocking: false,
    });
    expect(snapshot.runs[0]!.hasBlockingGates).toBe(false);
    expect(snapshot.tasks[0]!.gate).toBeNull();
    expect(meta.degraded.join('\n')).toMatch(/Gate options.*messages\.payload/s);
  });

  it('still merges the gate table when the messages cannot be read — additive to the last', async () => {
    const builder = new FixtureBuilder({ omitColumns: { messages: ['thread_id'] } });
    builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
    builder.gate({ taskId: 'task_a', question: 'From a row', createdAt: at(5) });

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => gate.question)).toEqual(['From a row']);
    expect(gates[0]).toMatchObject({ status: 'pending', blocking: true });
  });
});

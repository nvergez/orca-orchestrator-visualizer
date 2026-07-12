import { afterEach, describe, expect, it } from 'vitest';
import type { Gate } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **The highest-value trap in the map** (SPEC §4.2, trap 1; #19).
 *
 * `orchestration.ask` writes a `decision_gate` **message** and **no `decision_gates` row**.
 * The live database has **53 gate messages and 0 gate rows** — so a gates-from-the-table
 * implementation renders nothing, forever, on real runs *and passes an unwitting test suite*,
 * because a tidy fixture with gate rows makes it look correct.
 *
 * Every fixture below is therefore built the way the real database is: gate **messages**, and
 * (except where the additive merge is the thing under test) **zero** gate rows. If this file
 * is ever made to pass by reading `decision_gates`, the tool has shipped the bug the whole
 * ticket exists to prevent.
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

/** One task, worked by one worker — the smallest orchestration a gate can block. */
function orchestration(): FixtureBuilder {
  const builder = new FixtureBuilder();
  builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
  builder.dispatch({ taskId: 'task_a', assigneeHandle: WORKER, status: 'dispatched', dispatchedAt: at(1) });
  return builder;
}

/** A `decision_gate` message — the *only* source a real gate ever has. */
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

/** The answer. It threads on the gate *message's* id — that is what makes the gate resolved. */
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
    // The real shape, and the whole point: the table this data "belongs" in is empty.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    const gates = await gatesOf(builder);

    expect(gates).toHaveLength(1);
    expect(gates[0]).toMatchObject({
      messageId: 'msg_gate',
      taskId: 'task_a',
      question: 'Which driver?',
      options: ['node:sqlite', 'better-sqlite3'],
      status: 'open',
    });
  });

  it('is open while no reply threads on the gate message, and says so on the run and the node', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    // The open gate is what raises the strip, marks the node, and flags the run in the rail.
    expect(snapshot.gates[0]!.status).toBe('open');
    expect(snapshot.gates[0]!.resolution).toBeNull();
    expect(snapshot.runs[0]!.hasOpenGates).toBe(true);
    expect(snapshot.tasks[0]!.gate).toMatchObject({ status: 'open', question: 'Which driver?' });
  });

  it('is resolved by a reply threading on the gate message id, and the reply body is the resolution', async () => {
    // `orchestration.ask` replies thread on the *outbound message's* id (SPEC §4.5). Nothing
    // else in the schema records that a gate was ever answered.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });
    answers(builder, 'msg_gate', 'node:sqlite — zero native deps');

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]).toMatchObject({
      status: 'resolved',
      resolution: 'node:sqlite — zero native deps',
    });
    // An answered question blocks nothing: no strip, no rail flag, no ⛔ on the node.
    expect(snapshot.runs[0]!.hasOpenGates).toBe(false);
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
      ['Which transport?', 'open'],
    ]);
  });

  it('attaches a gate with no payload.taskId to its run and to no node', async () => {
    // 32 of the 53 live gate messages name no task. They still block the orchestration, so
    // they still raise the strip — they simply mark no node.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate' });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates[0]!.taskId).toBeNull();
    expect(snapshot.gates[0]!.runId).toBe(snapshot.runs[0]!.id);
    expect(snapshot.runs[0]!.hasOpenGates).toBe(true);
    expect(snapshot.tasks[0]!.gate).toBeNull();
  });

  it('keeps a gate whose taskId names a task a reset deleted — unlinked, never dropped', async () => {
    // No foreign keys anywhere in this schema (SPEC §4.2, trap 8). A dangling reference costs
    // the gate its node, not its place on screen.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_wiped_by_a_reset' });

    const gates = await gatesOf(builder);

    expect(gates).toHaveLength(1);
    expect(gates[0]!.taskId).toBeNull();
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

    expect(gates[0]).toMatchObject({ question: 'Blocked: which base branch?', options: [], status: 'open' });
  });

  it('normalizes the gate timestamp to an ISO instant, like every other one', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a', at: 5 });

    const gates = await gatesOf(builder);

    expect(gates[0]!.createdAt).toBe(at(5).toISOString());
  });

  it('carries the open gate to the node even when the task has an answered one too', async () => {
    // The ⛔ marker is about what is *blocking*. A task that has already answered one question
    // and is stuck on the next must show the one it is stuck on.
    const builder = orchestration();
    asks(builder, { id: 'msg_gate_1', taskId: 'task_a', question: 'Answered', at: 5 });
    answers(builder, 'msg_gate_1', 'yes');
    asks(builder, { id: 'msg_gate_2', taskId: 'task_a', question: 'Still blocking', at: 7 });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.tasks[0]!.gate).toMatchObject({ question: 'Still blocking', status: 'open' });
  });
});

/**
 * The `decision_gates` table is **additive and never primary** (SPEC §4.5). Orca's built-in
 * `Coordinator` loop writes rows there; nothing CLI-driven ever does. Merging them in can only
 * *add* a gate — it can never re-introduce the empty-panel failure above.
 */
describe('the decision_gates table, merged in additively', () => {
  it('adds a gate that exists only as a table row', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a', question: 'From a message' });
    builder.gate({ taskId: 'task_a', question: 'From a row', options: ['a', 'b'], createdAt: at(6) });

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => gate.question)).toEqual(['From a message', 'From a row']);
    expect(gates[1]).toMatchObject({ messageId: null, taskId: 'task_a', options: ['a', 'b'], status: 'open' });
  });

  it('deduplicates a row that says the same thing as a message, by (task_id, question)', async () => {
    const builder = orchestration();
    asks(builder, { id: 'msg_gate', taskId: 'task_a', question: 'Which driver?' });
    builder.gate({ taskId: 'task_a', question: 'Which driver?', createdAt: at(5) });

    const gates = await gatesOf(builder);

    // One question, asked once: the message is the source, and the row is a duplicate of it.
    expect(gates).toHaveLength(1);
    expect(gates[0]!.messageId).toBe('msg_gate');
  });

  it('keeps a row that asks the same question of a different task', async () => {
    const builder = orchestration();
    builder.task({ id: 'task_b', handle: COORDINATOR, title: 'The other thing', createdAt: at(2) });
    asks(builder, { id: 'msg_gate', taskId: 'task_a', question: 'Which driver?' });
    builder.gate({ taskId: 'task_b', question: 'Which driver?', createdAt: at(6) });

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => gate.taskId)).toEqual(['task_a', 'task_b']);
  });

  it("reads a row's resolution, and treats every status that is not 'resolved' as open", async () => {
    // `GateStatus = 'timeout'` never occurs (SPEC §4.2, trap 9) — `timeoutGate()` has no
    // callers outside Orca's own tests. If one ever did, an unanswered question is still an
    // unanswered question, so it shows as open rather than as a state nothing on screen knows.
    const builder = orchestration();
    builder.gate({ taskId: 'task_a', question: 'Answered in the table', status: 'resolved', resolution: 'yes', createdAt: at(5) });
    builder.gate({ taskId: 'task_a', question: 'Timed out', status: 'timeout', createdAt: at(6) });
    builder.gate({ taskId: 'task_a', question: 'Pending', status: 'pending', createdAt: at(7) });

    harness = await serve(builder.write(tempDbPath()));
    const { snapshot } = await harness.snapshot();

    expect(snapshot.gates.map((gate) => [gate.question, gate.status, gate.resolution])).toEqual([
      ['Answered in the table', 'resolved', 'yes'],
      ['Timed out', 'open', null],
      ['Pending', 'open', null],
    ]);
    expect(snapshot.runs[0]!.hasOpenGates).toBe(true);
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
    expect(gates.filter((gate) => gate.status === 'open')).toHaveLength(13);
    // Every one of them landed in a run, so every one of them can reach the strip.
    expect(gates.filter((gate) => gate.runId === null)).toHaveLength(0);
  });

  it('reads a question for every one of them, in both of the shapes the real database writes', async () => {
    // The trap inside the trap. On the live database *every* gate that names a task carries
    // `{taskId, dispatchId}` and puts its question in the subject — so a reader that takes the
    // question from `payload.question` alone renders a blank question on every gate that marks
    // a node, and a strip full of ⛔ with nothing written beside it.
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { gates } = (await harness.snapshot()).snapshot;

    expect(gates.filter((gate) => gate.question === '')).toHaveLength(0);
    expect(gates.filter((gate) => gate.taskId !== null && gate.question !== '')).toHaveLength(21);
  });

  it('flags exactly the runs that are blocked, and marks exactly the nodes that are', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { snapshot } = await harness.snapshot();
    const openGates = snapshot.gates.filter((gate) => gate.status === 'open');

    const blockedRuns = new Set(openGates.map((gate) => gate.runId));
    expect(new Set(snapshot.runs.filter((run) => run.hasOpenGates).map((run) => run.id))).toEqual(blockedRuns);
    expect(blockedRuns.size).toBeGreaterThan(0);

    const marked = snapshot.tasks.filter((task) => task.gate?.status === 'open').map((task) => task.id);
    expect(new Set(marked)).toEqual(new Set(openGates.map((gate) => gate.taskId).filter(Boolean)));
  });
});

describe('an Orca whose schema cannot answer the question', () => {
  it('degrades the gates rather than reporting every gate open forever', async () => {
    // With no `thread_id` there is no way to tell an answered gate from an open one, and a
    // strip raised over 53 questions that were all answered days ago is worse than no strip.
    // So the feature degrades, by name, and the user is told why (#21).
    const builder = new FixtureBuilder({ omitColumns: { messages: ['thread_id'] } });
    builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
    asks(builder, { id: 'msg_gate', taskId: 'task_a' });

    harness = await serve(builder.write(tempDbPath()));
    const { meta, snapshot } = await harness.snapshot();

    expect(snapshot.gates).toEqual([]);
    expect(snapshot.runs[0]!.hasOpenGates).toBe(false);
    expect(meta.degraded.join('\n')).toMatch(/[Dd]ecision gates .*thread_id/s);
  });

  it('still merges the gate table when the messages cannot be read — additive to the last', async () => {
    const builder = new FixtureBuilder({ omitColumns: { messages: ['thread_id'] } });
    builder.task({ id: 'task_a', handle: COORDINATOR, title: 'Ship the thing', createdAt: AT });
    builder.gate({ taskId: 'task_a', question: 'From a row', createdAt: at(5) });

    const gates = await gatesOf(builder);

    expect(gates.map((gate) => gate.question)).toEqual(['From a row']);
  });
});

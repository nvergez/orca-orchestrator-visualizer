import { afterEach, describe, expect, it } from 'vitest';
import { selectTurns } from '../../src/client/conversation/select.ts';
import { agentOfTurn, type StreamEvent, type Turn } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor, syntheticId } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **The conversation — and the trap the whole feature turns on** (SPEC §4.7).
 *
 * When the orchestrator dispatches an agent it writes **no message**. Orca injects the prompt
 * straight into the worker's PTY, and the live database holds **zero** `type = 'dispatch'` rows
 * (SPEC §4.2, trap 2). A conversation read out of the `messages` table alone therefore shows agents
 * talking into the void, to an orchestrator that never answers a word — and it would pass a naive
 * test suite, because a tidy fixture full of `dispatch` messages makes it look correct.
 *
 * So the fixtures below contain **no `dispatch` message rows at all**, exactly like the real
 * database. Every orchestrator turn these tests assert had to be *reconstructed* from four sources:
 *
 * | Turn | Reconstructed from |
 * |---|---|
 * | The prompt | `tasks.spec` at `dispatch_contexts.dispatched_at` |
 * | The reply | `messages` |
 * | A question and its answer | a `decision_gate` message, and the reply threading on its `id` |
 * | The report | `tasks.result` at `tasks.completed_at` |
 *
 * And the merge orders columns written by **both** of Orca's timestamp writers against each other
 * (SPEC §4.2, trap 5) — `dispatched_at` is SQL-format, `tasks.completed_at` is ISO — which is the
 * exact comparison that trap exists to break.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const BOSS = handleFor('boss');
const ALICE = handleFor('alice');
const BOB = handleFor('bob');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

async function snapshotOf(builder: FixtureBuilder): Promise<StreamEvent> {
  harness = await serve(builder.write(tempDbPath()));
  return harness.snapshot();
}

async function turnsOf(builder: FixtureBuilder): Promise<Turn[]> {
  return (await snapshotOf(builder)).snapshot.turns;
}

/** What the panel actually renders, in order: who said what, and where it came from. */
function script(turns: Turn[]): string[] {
  return turns.map((turn) => `${turn.direction} ${turn.kind}`);
}

describe('the orchestrator speaks — and no message says so', () => {
  it('reconstructs the dispatch prompt from tasks.spec and dispatch_contexts.dispatched_at', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: BOSS,
          spec: 'Port the canvas to React Flow. Keep the six status colours exactly as they are.',
          status: 'dispatched',
          createdAt: at(0),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(10 * MINUTE) })
    );

    // There is not one `dispatch` message row in that fixture, and there is not one in the real
    // database either. This turn exists because two *columns* were merged into it.
    const dispatch = turns.find((turn) => turn.kind === 'dispatch');

    expect(dispatch).toMatchObject({
      direction: 'out',
      fromHandle: BOSS,
      toHandle: ALICE,
      taskId: 'task_1',
      at: at(10 * MINUTE).toISOString(),
      body: 'Port the canvas to React Flow. Keep the six status colours exactly as they are.',
      source: 'tasks.spec · dispatch_contexts.dispatched_at',
    });

    // The agent side of the turn is derived, never carried: it is always one of the two handles
    // already on it, and a third copy of a uuid in an object re-sent every five seconds is 21 KB
    // per push to save one line of arithmetic (`agentOfTurn`).
    expect(agentOfTurn(dispatch!)).toBe(ALICE);
  });

  it('reconstructs the final report from tasks.result and tasks.completed_at', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: BOSS,
          status: 'completed',
          result: 'Canvas and theme done. Six statuses, light and dark.',
          createdAt: at(0),
          completedAt: at(2 * HOUR),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
    );

    expect(turns.find((turn) => turn.kind === 'result')).toMatchObject({
      direction: 'in',
      fromHandle: ALICE,
      toHandle: BOSS,
      at: at(2 * HOUR).toISOString(),
      body: 'Canvas and theme done. Six statuses, light and dark.',
      source: 'tasks.result · tasks.completed_at',
    });
  });

  it('emits one dispatch turn per *attempt* — a retry is a separate thing the orchestrator did', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, spec: 'Wire the inspector.', status: 'completed', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, status: 'failed', failureCount: 1, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: BOB, status: 'completed', dispatchedAt: at(30 * MINUTE) })
    );

    const dispatches = turns.filter((turn) => turn.kind === 'dispatch');

    expect(dispatches).toHaveLength(2);
    expect(dispatches.map((turn) => turn.toHandle)).toEqual([ALICE, BOB]);
    // And it says which attempt it was, because two identical prompts an hour apart otherwise read
    // as the tool having drawn the same bubble twice.
    expect(dispatches[1]!.source).toBe('tasks.spec · dispatch_contexts.dispatched_at · attempt 2 of 2');
  });

  it('still emits the turn when the task has no spec — the dispatch happened either way', async () => {
    harness = await serve(
      new FixtureBuilder({ omitColumns: { tasks: ['spec'] } })
        .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .write(tempDbPath())
    );

    const { meta, snapshot } = await harness.snapshot();

    const dispatch = snapshot.turns.find((turn) => turn.kind === 'dispatch');
    expect(dispatch?.toHandle).toBe(ALICE);
    expect(dispatch?.body).toMatch(/not in the database/);

    // …and the user is told which feature the missing column cost, by name (SPEC §5).
    expect(meta.degraded.join('\n')).toMatch(/The orchestrator's side of the conversation/);
  });
});

describe('the agents answer', () => {
  it('puts the agent’s messages on the incoming side, and the orchestrator’s on the outgoing', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, spec: 'Do the thing.', status: 'completed', createdAt: at(0), completedAt: at(HOUR), result: 'Done.' })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          type: 'status',
          fromHandle: ALICE,
          toHandle: BOSS,
          subject: 'Progress',
          body: 'Halfway there.',
          payload: { taskId: 'task_1' },
          createdAt: at(20 * MINUTE),
        })
        .message({
          type: 'worker_done',
          fromHandle: ALICE,
          toHandle: BOSS,
          subject: 'Done',
          payload: { taskId: 'task_1' },
          createdAt: at(50 * MINUTE),
        })
    );

    // Both sides of the dialogue, in the order they happened — which is the whole feature in one
    // assertion. Without the merge, the first and last lines here simply would not exist.
    expect(script(turns)).toEqual(['out dispatch', 'in status', 'in worker_done', 'in result']);
  });

  it('renders a message that names a task a reset deleted — attached to nobody', async () => {
    // No foreign keys (SPEC §4.2, trap 8): the join has to miss without taking the turn down.
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          type: 'status',
          fromHandle: ALICE,
          toHandle: BOSS,
          subject: 'Progress on a task that no longer exists',
          payload: { taskId: 'task_wiped_by_reset' },
          createdAt: at(20 * MINUTE),
        })
    );

    const orphan = turns.find((turn) => turn.subject.includes('no longer exists'));

    expect(orphan).toBeDefined();
    expect(orphan!.taskId).toBeNull(); // The link is broken…
    expect(orphan!.direction).toBe('in'); // …and the row is not.
  });
});

describe('a question, and its answer', () => {
  it('threads the orchestrator’s reply onto the gate it answers', async () => {
    const gateId = syntheticId('msg', 'the-gate');

    const turns = await turnsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, spec: 'Do the thing.', status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          id: gateId,
          type: 'decision_gate',
          fromHandle: ALICE,
          toHandle: BOSS,
          subject: 'Decision needed',
          payload: { taskId: 'task_1', question: 'Keep the accent, or invert it?', options: ['keep', 'invert'] },
          createdAt: at(20 * MINUTE),
        })
        .message({
          type: 'status',
          fromHandle: BOSS,
          toHandle: ALICE,
          subject: 'Re: decision',
          body: 'keep',
          // The one record anywhere in this schema that a question was ever answered.
          threadId: gateId,
          createdAt: at(22 * MINUTE),
        })
    );

    const gate = turns.find((turn) => turn.kind === 'decision_gate')!;
    const answer = turns.find((turn) => turn.kind === 'answer')!;

    expect(gate).toMatchObject({
      direction: 'in',
      body: 'Keep the accent, or invert it?',
      options: ['keep', 'invert'],
      answer: 'keep', // …so the panel can tick the option that was taken.
      gateStatus: 'resolved',
    });
    // A resolved question blocks nothing, and a false field is 360 × 16 bytes of nothing (`Turn`).
    expect(gate.blocking).toBeUndefined();

    expect(answer).toMatchObject({
      direction: 'out',
      fromHandle: BOSS,
      toHandle: ALICE,
      body: 'keep',
    });
    expect(answer.source).toMatch(/messages\.thread_id = the gate's id/);

    // The question comes before the answer, on one timeline.
    expect(turns.indexOf(gate)).toBeLessThan(turns.indexOf(answer));
  });

  it('leaves an unanswered gate with no answer — no answer recorded is all silence proves', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          type: 'decision_gate',
          fromHandle: ALICE,
          toHandle: BOSS,
          subject: 'Should the scroller be a block, or inherit?',
          payload: { taskId: 'task_1', dispatchId: 'ctx_1' },
          createdAt: at(20 * MINUTE),
        })
    );

    const gate = turns.find((turn) => turn.kind === 'decision_gate')!;

    // Absent, not null: a field with nothing to say does not say it, because the snapshot is
    // re-sent whole every five seconds (`Turn`).
    expect(gate.answer).toBeUndefined();
    expect(gate.gateStatus).toBe('unanswered');
    // The task is `dispatched` — work is moving, so this reply-less ask blocks nothing (#45),
    // and the panel must say "no answer recorded" rather than "waiting".
    expect(gate.blocking).toBeUndefined();
    // Half the live database's gate messages carry no `payload.question` — the worker wrote it in
    // the subject. Reading the payload alone would leave this bubble blank.
    expect(gate.body).toBe('Should the scroller be a block, or inherit?');
    expect(turns.some((turn) => turn.kind === 'answer')).toBe(false);
  });

  it('says out loud when an unanswered question is blocking now — its task is authoritatively blocked', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, status: 'blocked', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          type: 'decision_gate',
          fromHandle: ALICE,
          toHandle: BOSS,
          subject: 'Which base branch?',
          payload: { taskId: 'task_1', dispatchId: 'ctx_1' },
          createdAt: at(20 * MINUTE),
        })
    );

    const gate = turns.find((turn) => turn.kind === 'decision_gate')!;

    expect(gate).toMatchObject({ gateStatus: 'unanswered', blocking: true });
    expect(gate.answer).toBeUndefined();
  });

  it("carries a Coordinator row twin's authoritative lifecycle onto the turn — resolution and timeout alike", async () => {
    // The #45 collision, as the conversation sees it: resolution lives only in the
    // `decision_gates` row, and a panel reading threads alone would show this question
    // as waiting forever.
    const gateId = syntheticId('msg', 'the-twin');

    const builder = new FixtureBuilder()
      .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
      .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
      .message({
        id: gateId,
        type: 'decision_gate',
        fromHandle: ALICE,
        toHandle: BOSS,
        subject: 'Decision needed',
        payload: { taskId: 'task_1', question: 'Keep the accent, or invert it?', options: ['keep', 'invert'] },
        createdAt: at(20 * MINUTE),
      })
      .gate({
        taskId: 'task_1',
        question: 'Keep the accent, or invert it?',
        status: 'resolved',
        resolution: 'keep',
        createdAt: at(21 * MINUTE),
      })
      .message({
        type: 'decision_gate',
        fromHandle: ALICE,
        toHandle: BOSS,
        subject: 'Decision needed',
        payload: { taskId: 'task_1', question: 'Ship it today?', options: ['yes', 'no'] },
        createdAt: at(30 * MINUTE),
      })
      .gate({ taskId: 'task_1', question: 'Ship it today?', status: 'timeout', createdAt: at(31 * MINUTE) });

    const turns = await turnsOf(builder);
    const gates = turns.filter((turn) => turn.kind === 'decision_gate');

    // No reply threaded on either message — the row is the only record, and it is enough.
    expect(gates[0]).toMatchObject({ gateStatus: 'resolved', answer: 'keep' });
    expect(gates[1]).toMatchObject({ gateStatus: 'timeout' });
    expect(gates[1]!.answer).toBeUndefined();
    expect(gates[1]!.blocking).toBeUndefined(); // timeout is terminal — never a blocker (#45)
  });
});

describe('heartbeats', () => {
  it('collapses them into one row per task, and counts what it stood in for', async () => {
    const builder = new FixtureBuilder()
      .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
      .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) });

    for (let beat = 0; beat < 18; beat++) {
      builder.message({
        type: 'heartbeat',
        fromHandle: ALICE,
        toHandle: BOSS,
        subject: 'alive',
        payload: { taskId: 'task_1' },
        createdAt: at((5 + beat * 5) * MINUTE),
      });
    }

    const turns = await turnsOf(builder);

    const beats = turns.filter((turn) => turn.kind === 'heartbeats');

    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({
      beatCount: 18,
      taskId: 'task_1',
      // Positioned where the beating *started*, and carrying the span, so the panel can say
      // "every ~5 min" out of two instants and a count rather than asserting a cadence.
      at: at(5 * MINUTE).toISOString(),
      endedAt: at(90 * MINUTE).toISOString(),
    });
    expect(agentOfTurn(beats[0]!)).toBe(ALICE);

    // …and not one of the eighteen appears on its own.
    expect(turns.some((turn) => turn.kind === 'heartbeat')).toBe(false);
  });

  it('collapses by task, so the summary survives every scope the panel can ask for', async () => {
    // The rule that makes this work: a heartbeat carries a taskId, a task belongs to one agent and
    // one orchestrator — so a summary keyed on the task is *wholly inside* every scope. Collapsing
    // by adjacency in the global order would straddle them and count beats the reader cannot see.
    const builder = new FixtureBuilder()
      .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
      .task({ id: 'task_2', handle: BOSS, status: 'dispatched', createdAt: at(0) })
      .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
      .dispatch({ taskId: 'task_2', assigneeHandle: BOB, dispatchedAt: at(MINUTE) });

    // Interleaved in time, which is what really happens when two agents are working at once.
    for (let beat = 0; beat < 6; beat++) {
      builder.message({ type: 'heartbeat', fromHandle: ALICE, toHandle: BOSS, subject: 'alive', payload: { taskId: 'task_1' }, createdAt: at((10 + beat * 10) * MINUTE) });
      builder.message({ type: 'heartbeat', fromHandle: BOB, toHandle: BOSS, subject: 'alive', payload: { taskId: 'task_2' }, createdAt: at((12 + beat * 10) * MINUTE) });
    }

    const turns = await turnsOf(builder);
    const beats = turns.filter((turn) => turn.kind === 'heartbeats');

    expect(beats).toHaveLength(2);
    expect(beats.map((turn) => turn.beatCount)).toEqual([6, 6]);

    // Scoped to one agent, exactly one summary survives — and it is that agent's.
    const alicesBeats = selectTurns(turns, { runId: null, agentHandle: ALICE }).filter((turn) => turn.kind === 'heartbeats');
    expect(alicesBeats).toHaveLength(1);
    expect(alicesBeats[0]!.beatCount).toBe(6);
  });
});

describe('the two timestamp formats meet here (SPEC §4.2, trap 5)', () => {
  it('orders a SQL-format dispatched_at against an ISO completed_at correctly', async () => {
    // `dispatch_contexts.dispatched_at` is `'YYYY-MM-DD HH:MM:SS'` UTC; `tasks.completed_at` is
    // ISO-8601. Compared unnormalized — `new Date('2026-07-08 12:01:00')` is parsed as *local* time —
    // this run would report a task that finished before it was dispatched, west of UTC.
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: BOSS,
          spec: 'The prompt.',
          status: 'completed',
          result: 'The report.',
          createdAt: at(0),
          completedAt: at(3 * HOUR),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
    );

    expect(script(turns)).toEqual(['out dispatch', 'in result']);

    // Both instants come out the other side as ISO — the client never sees the split (SPEC §4.2).
    for (const turn of turns) expect(turn.at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });
});

describe('scoping (client/conversation/select.ts, asserted against a real snapshot)', () => {
  it('narrows to one orchestrator, then one agent, then one task', async () => {
    const { snapshot } = await snapshotOf(liveShapeCorpus());

    const run = snapshot.runs.find((candidate) => candidate.cast.length >= 2)!;
    const agent = run.cast[0]!;

    const everything = snapshot.turns;
    const theirs = selectTurns(everything, { runId: run.id });
    const agents = selectTurns(everything, { runId: run.id, agentHandle: agent.handle });
    const task = selectTurns(everything, { runId: run.id, agentHandle: agent.handle, taskId: agent.taskIds[0]! });

    // Each scope is a subset of the one before it.
    expect(theirs.length).toBeLessThan(everything.length);
    expect(agents.length).toBeLessThan(theirs.length);
    expect(task.length).toBeLessThanOrEqual(agents.length);
    expect(task.length).toBeGreaterThan(0);

    // And the agent's scope really is only theirs.
    for (const turn of agents) expect(agentOfTurn(turn)).toBe(agent.handle);
  });

  it('shows a turn no orchestrator could claim in "All" and nowhere else (SPEC §4.4, rule 3)', async () => {
    // A message between two terminals that never created a task and never held one: nothing in the
    // schema says which orchestration it belonged to, and nothing here pretends to know. It must
    // still **appear** — an unattributable message shows up attached to nobody, rather than being
    // guessed into somebody's conversation or dropped on the floor.
    const stranger = handleFor('a-terminal-nobody-knows');

    const { snapshot } = await snapshotOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: BOSS, status: 'dispatched', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          type: 'status',
          fromHandle: stranger,
          toHandle: handleFor('another-stranger'),
          subject: 'A conversation this database cannot place',
          createdAt: at(20 * MINUTE),
        })
    );

    const unplaced = snapshot.turns.filter((turn) => turn.runId === null);
    expect(unplaced).toHaveLength(1);
    expect(unplaced[0]!.subject).toBe('A conversation this database cannot place');

    // "All" is `runId: null` — the scope that filters by nothing, and the only one it appears in.
    expect(selectTurns(snapshot.turns, { runId: null })).toEqual(snapshot.turns);

    for (const run of snapshot.runs) {
      const theirs = selectTurns(snapshot.turns, { runId: run.id });
      expect(theirs.some((turn) => unplaced.includes(turn))).toBe(false);
    }
  });

  it('places the messages of a task a reset deleted, by handle — the run still knows who was talking', async () => {
    // The corpus's three post-reset orphans (`payload.taskId` → a task that is gone) keep their
    // **run**: rule 1 misses, and rule 2 recognises the handles and the window. That is the
    // difference between a broken link and a lost message, and it is why they are two rules.
    const { snapshot } = await snapshotOf(liveShapeCorpus());

    const orphans = snapshot.turns.filter((turn) => turn.subject.includes('no longer exists'));

    expect(orphans.length).toBe(3);
    for (const orphan of orphans) {
      expect(orphan.taskId).toBeNull(); // The node link is broken…
      expect(orphan.runId).not.toBeNull(); // …and the conversation still has it.
    }
  });
});

describe('against the live-shaped corpus', () => {
  it('gives the orchestrator a voice in every conversation an agent ever spoke in', async () => {
    // The regression this whole ticket exists to prevent: a conversation with only one speaker.
    const { snapshot } = await snapshotOf(liveShapeCorpus());

    const speaking = snapshot.runs.filter((run) => run.cast.length > 0);
    expect(speaking.length).toBeGreaterThan(5);

    for (const run of speaking) {
      const theirs = selectTurns(snapshot.turns, { runId: run.id });

      expect(theirs.some((turn) => turn.direction === 'out')).toBe(true);
      expect(theirs.some((turn) => turn.direction === 'in')).toBe(true);
    }
  });

  it('has no `dispatch` message rows to have built those turns out of', async () => {
    // The live database has zero. If the corpus ever gained one, the assertion above would start
    // passing for the wrong reason — and the trap would be back, undetected.
    const { snapshot, messages } = await snapshotOf(liveShapeCorpus());

    expect(messages.some((message) => message.type === 'dispatch')).toBe(false);
    expect(snapshot.turns.filter((turn) => turn.kind === 'dispatch').length).toBeGreaterThan(50);
  });

  it('orders the whole conversation by a normalized instant', async () => {
    const { snapshot } = await snapshotOf(liveShapeCorpus());

    const instants = snapshot.turns.map((turn) => Date.parse(turn.at)).filter((at) => !Number.isNaN(at));

    expect(instants.length).toBe(snapshot.turns.length);
    for (let i = 1; i < instants.length; i++) {
      expect(instants[i]!).toBeGreaterThanOrEqual(instants[i - 1]!);
    }
  });

  it('caps a dispatch body and says so, rather than shipping 172 KB of prompt every tick', async () => {
    const builder = new FixtureBuilder()
      .task({ id: 'task_1', handle: BOSS, spec: 'x'.repeat(4000), status: 'dispatched', createdAt: at(0) })
      .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) });

    const dispatch = (await turnsOf(builder)).find((turn) => turn.kind === 'dispatch')!;

    expect(dispatch.body).toHaveLength(240);
    expect(dispatch.truncated).toBe(true);
  });
});

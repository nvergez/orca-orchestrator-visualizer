import { afterEach, describe, expect, it } from 'vitest';
import type { RunIndexPage, RunSnapshot } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { FixtureWriter } from '../fixtures/writer.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Seam 1 (#12): the paged history transport of #69, over real HTTP against a real fixture
 * database — the run index (`GET /api/runs`), the selected-run snapshot (`GET /api/run/:id`),
 * and the two promises they divide between them (ADR 0002):
 *
 * - **The index is bounded and explicit.** The first page is the 50 most recently active
 *   summaries; older history is behind a cursor a client has to *follow* — reachable, never
 *   silently cut off, and stable: an unchanged database tiles into pages with no duplicate and
 *   no omission, and a database that grew between two page fetches still never duplicates a
 *   row into a later page.
 * - **The selected run is complete.** Every retained task, attempt, gate and turn, however old
 *   or large the run — scaling the index is not allowed to weaken a post-mortem.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;

let harness: Harness | undefined;
let writer: FixtureWriter | undefined;

afterEach(async () => {
  writer?.close();
  writer = undefined;
  await harness?.close();
  harness = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

/**
 * `count` one-task runs, each on its own handle, one minute apart — run 0 is the oldest and
 * run `count-1` the most recently active, so the expected index order is simply reversed.
 */
function manyRuns(count: number): FixtureBuilder {
  const builder = new FixtureBuilder();
  for (let index = 0; index < count; index++) {
    builder.task({
      id: `task_run${String(index).padStart(3, '0')}`,
      handle: handleFor(`orchestrator-${index}`),
      title: `Work item ${index}`,
      createdAt: at(index * MINUTE),
    });
  }
  return builder;
}

async function indexPage(cursor?: string): Promise<RunIndexPage> {
  const response = await harness!.runs(cursor);
  expect(response.status).toBe(200);
  return (await response.json()) as RunIndexPage;
}

async function runSnapshot(id: string): Promise<RunSnapshot> {
  const response = await harness!.run(id);
  expect(response.status).toBe(200);
  return (await response.json()) as RunSnapshot;
}

describe('GET /api/runs — the run index', () => {
  it('returns every run, most recently active first, when history fits one page', async () => {
    harness = await serve(manyRuns(3).write(tempDbPath()));

    const page = await indexPage();

    expect(page.runs.map((run) => run.label)).toEqual(['Work item 2', 'Work item 1', 'Work item 0']);
    // No cursor when history ends here — null is "there is no more", said only when true.
    expect(page.nextCursor).toBeNull();
    // The header every payload carries: the degradation report must survive the transport (#69).
    expect(page.meta.schemaVersion).toBe(5);
    expect(page.meta.degraded).toEqual([]);
    expect(page.coordinatorRuns).toEqual([]);
  });

  it('caps the first page at the 50 most recently active summaries and pages the rest', async () => {
    harness = await serve(manyRuns(55).write(tempDbPath()));

    const first = await indexPage();
    expect(first.runs).toHaveLength(50);
    expect(first.runs[0]!.label).toBe('Work item 54');
    expect(first.nextCursor).not.toBeNull();

    const second = await indexPage(first.nextCursor!);
    expect(second.runs.map((run) => run.label)).toEqual([
      'Work item 4',
      'Work item 3',
      'Work item 2',
      'Work item 1',
      'Work item 0',
    ]);
    expect(second.nextCursor).toBeNull();

    // The two pages tile history exactly: 55 distinct runs, nothing duplicated, nothing dropped.
    const ids = [...first.runs, ...second.runs].map((run) => run.id);
    expect(new Set(ids).size).toBe(55);
  });

  it('answers the same cursor with the same page, deterministically', async () => {
    harness = await serve(manyRuns(53).write(tempDbPath()));

    const first = await indexPage();
    const once = await indexPage(first.nextCursor!);
    const again = await indexPage(first.nextCursor!);

    expect(again).toEqual(once);
  });

  it('never duplicates a run into a later page when new history arrives between fetches', async () => {
    const dbPath = manyRuns(55).write(tempDbPath());
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const first = await indexPage();

    // A brand-new orchestrator starts while the reader holds page one's cursor.
    writer.task({ handle: handleFor('newcomer'), title: 'Fresh work', createdAt: at(70 * MINUTE) });

    // The old cursor still yields exactly the old tail: the newcomer sorts *ahead* of every
    // existing cursor position, so it cannot leak into an older page…
    const second = await indexPage(first.nextCursor!);
    expect(second.runs.map((run) => run.label)).toEqual([
      'Work item 4',
      'Work item 3',
      'Work item 2',
      'Work item 1',
      'Work item 0',
    ]);

    // …and a refreshed first page is where it surfaces, on top.
    const refreshed = await indexPage();
    expect(refreshed.runs[0]!.label).toBe('Fresh work');
  });

  it('moves a run that gained activity to the refreshed first page without duplicating it', async () => {
    const dbPath = manyRuns(55).write(tempDbPath());
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const first = await indexPage();

    // 'Work item 2' lives on page two. Its orchestrator picks the work back up.
    writer.task({ handle: handleFor('orchestrator-2'), title: 'Picked back up', createdAt: at(71 * MINUTE) });

    const second = await indexPage(first.nextCursor!);
    const refreshed = await indexPage();

    // It moved ahead of the cursor — off the older page, onto the top of a fresh first page.
    // One run, one place; a page boundary never shows it twice.
    expect(second.runs.map((run) => run.label)).toEqual([
      'Work item 4',
      'Work item 3',
      'Work item 1',
      'Work item 0',
    ]);
    expect(refreshed.runs[0]!.id).toBe(`run_${handleFor('orchestrator-2')}`);
    expect(refreshed.runs.filter((run) => run.id === `run_${handleFor('orchestrator-2')}`)).toHaveLength(1);
  });

  it('refuses a cursor it never minted with a 400, not a silent first page', async () => {
    harness = await serve(manyRuns(2).write(tempDbPath()));

    for (const nonsense of ['not-a-cursor', Buffer.from('{"almost":"ours"}').toString('base64url')]) {
      const response = await harness.runs(nonsense);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('cursor');
    }
  });
});

describe('GET /api/run/:id — the selected-run snapshot', () => {
  const ORCHESTRATOR = handleFor('orchestrator');
  const WORKER_ONE = handleFor('worker-one');
  const WORKER_TWO = handleFor('worker-two');
  const NEIGHBOUR = handleFor('neighbour');

  /**
   * One run with everything a post-mortem reads — a retried task (two attempts), a gate and its
   * answer, heartbeats, a result — plus a second run whose task the first depends on, an
   * unattributed task, and a message no run can claim.
   */
  function richFixture(): FixtureBuilder {
    return (
      new FixtureBuilder()
        // The neighbouring run: the far end of a cross-run dependency edge.
        .task({ id: 'task_far', handle: NEIGHBOUR, title: 'Groundwork', createdAt: at(-60 * MINUTE) })
        // The selected run.
        .task({
          id: 'task_one',
          handle: ORCHESTRATOR,
          title: 'Build the thing',
          spec: 'Please build the thing.',
          status: 'completed',
          deps: ['task_far'],
          result: 'Built it.',
          createdAt: at(0),
          completedAt: at(30 * MINUTE),
        })
        .task({
          id: 'task_two',
          handle: ORCHESTRATOR,
          title: 'Retry the other thing',
          status: 'dispatched',
          createdAt: at(5 * MINUTE),
        })
        // task_one: one attempt. task_two: two — the retry record the snapshot must keep whole.
        .dispatch({
          id: 'ctx_one',
          taskId: 'task_one',
          assigneeHandle: WORKER_ONE,
          status: 'completed',
          dispatchedAt: at(1 * MINUTE),
          completedAt: at(29 * MINUTE),
        })
        .dispatch({
          id: 'ctx_two_a',
          taskId: 'task_two',
          assigneeHandle: WORKER_ONE,
          status: 'failed',
          failureCount: 1,
          dispatchedAt: at(6 * MINUTE),
        })
        .dispatch({
          id: 'ctx_two_b',
          taskId: 'task_two',
          assigneeHandle: WORKER_TWO,
          status: 'dispatched',
          dispatchedAt: at(10 * MINUTE),
          lastHeartbeatAt: at(20 * MINUTE),
        })
        // The agent reporting, a gate and its answer, and heartbeats to collapse.
        .message({
          fromHandle: WORKER_ONE,
          toHandle: ORCHESTRATOR,
          subject: 'Done',
          type: 'worker_done',
          payload: { taskId: 'task_one' },
          createdAt: at(29 * MINUTE),
        })
        .message({
          id: 'msg_gate',
          fromHandle: WORKER_TWO,
          toHandle: ORCHESTRATOR,
          subject: 'Which way?',
          type: 'decision_gate',
          payload: { taskId: 'task_two', question: 'Which way?', options: ['left', 'right'] },
          createdAt: at(12 * MINUTE),
        })
        .message({
          fromHandle: ORCHESTRATOR,
          toHandle: WORKER_TWO,
          subject: 'Re: Which way?',
          body: 'left',
          threadId: 'msg_gate',
          createdAt: at(13 * MINUTE),
        })
        .message({
          fromHandle: WORKER_TWO,
          toHandle: ORCHESTRATOR,
          subject: 'alive',
          type: 'heartbeat',
          payload: { taskId: 'task_two' },
          createdAt: at(15 * MINUTE),
        })
        .message({
          fromHandle: WORKER_TWO,
          toHandle: ORCHESTRATOR,
          subject: 'alive',
          type: 'heartbeat',
          payload: { taskId: 'task_two' },
          createdAt: at(20 * MINUTE),
        })
        // A message naming handles no run has — placeable nowhere, honestly (SPEC §4.4, rule 3).
        .message({
          fromHandle: handleFor('stranger'),
          toHandle: handleFor('other-stranger'),
          subject: 'Lost',
          createdAt: at(21 * MINUTE),
        })
        // An unattributed task: the synthetic run must be selectable like any other.
        .task({ id: 'task_orphan', handle: null, title: 'Orphan', createdAt: at(2 * MINUTE) })
    );
  }

  it('fetches one run whole: every task, attempt, gate and turn, and nothing of anybody else', async () => {
    harness = await serve(richFixture().write(tempDbPath()));

    const snapshot = await runSnapshot(`run_${ORCHESTRATOR}`);

    expect(snapshot.run.id).toBe(`run_${ORCHESTRATOR}`);
    expect(snapshot.run.cast.map((member) => member.handle)).toEqual([WORKER_ONE, WORKER_TWO]);

    // Every task of this run — and only this run's.
    expect(snapshot.tasks.map((task) => task.id)).toEqual(['task_one', 'task_two']);

    // **Every** attempt, oldest first — the retry is the record, not noise to fold away.
    expect(snapshot.attempts['task_one']!.map((attempt) => attempt.id)).toEqual(['ctx_one']);
    expect(snapshot.attempts['task_two']!.map((attempt) => attempt.id)).toEqual(['ctx_two_a', 'ctx_two_b']);

    // The gate, with its answer threaded on.
    expect(snapshot.gates).toHaveLength(1);
    expect(snapshot.gates[0]).toMatchObject({ taskId: 'task_two', status: 'resolved', resolution: 'left' });

    // The four-source conversation, complete: both dispatch prompts as separate attempts, the
    // report, the gate and answer, the result, and the heartbeats collapsed to one line.
    const kinds = snapshot.turns.map((turn) => turn.kind);
    expect(kinds.filter((kind) => kind === 'dispatch')).toHaveLength(3); // one per *attempt*
    expect(kinds).toContain('worker_done');
    expect(kinds).toContain('decision_gate');
    expect(kinds).toContain('result');
    expect(kinds.filter((kind) => kind === 'heartbeats')).toHaveLength(1);

    // The far end of the cross-run dependency edge rides along for the dep chips.
    expect(snapshot.linkedTasks.map((task) => task.id)).toEqual(['task_far']);

    expect(snapshot.meta.degraded).toEqual([]);
  });

  it('carries the turns nothing places, attached to nobody, beside the run’s own', async () => {
    harness = await serve(richFixture().write(tempDbPath()));

    const snapshot = await runSnapshot(`run_${ORCHESTRATOR}`);

    const lost = snapshot.turns.find((turn) => turn.subject === 'Lost');
    expect(lost).toBeDefined();
    expect(lost!.runId).toBeNull();

    // …and no other run's turns leaked in with them.
    const foreign = snapshot.turns.filter((turn) => turn.runId !== null && turn.runId !== `run_${ORCHESTRATOR}`);
    expect(foreign).toEqual([]);
  });

  it('serves the synthetic unattributed run like any other', async () => {
    harness = await serve(richFixture().write(tempDbPath()));

    const snapshot = await runSnapshot('run_unattributed');

    expect(snapshot.run.handle).toBeNull();
    expect(snapshot.tasks.map((task) => task.id)).toEqual(['task_orphan']);
  });

  it('keeps a selected run complete however large it is — the index pages, the run never does', async () => {
    // Far more tasks than a page of the *index*: the two limits must not leak into each other.
    const builder = new FixtureBuilder();
    const handle = handleFor('huge');
    for (let index = 0; index < 120; index++) {
      builder.task({ handle, title: `Step ${index}`, createdAt: at(index * MINUTE) });
    }
    harness = await serve(builder.write(tempDbPath()));

    const snapshot = await runSnapshot(`run_${handle}`);

    expect(snapshot.tasks).toHaveLength(120);
    // One dispatch-less task is one spec turn short of nothing — but every *retained* turn is
    // here: the conversation is never windowed to the recent ones.
    expect(snapshot.run.taskCount).toBe(120);
  });

  it('answers an id that names no run with a 404', async () => {
    harness = await serve(richFixture().write(tempDbPath()));

    const response = await harness.run('run_nobody');
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain('run_nobody');
  });
});

describe('SSE: targeted invalidation, and lossless reconnect (#69)', () => {
  const ORCHESTRATOR = handleFor('sse-orchestrator');
  const OTHER = handleFor('sse-other');
  const WORKER = handleFor('sse-worker');

  /** Two independent runs, so "targeted" is falsifiable: a change to one must not name the other. */
  function twoRuns(): FixtureBuilder {
    return new FixtureBuilder()
      .task({ id: 'task_mine', handle: ORCHESTRATOR, title: 'Mine', createdAt: at(0) })
      .dispatch({ id: 'ctx_mine', taskId: 'task_mine', assigneeHandle: WORKER, dispatchedAt: at(MINUTE) })
      .task({ id: 'task_other', handle: OTHER, title: 'Other', createdAt: at(2 * MINUTE) });
  }

  it('claims the whole view on a first connect — the one moment nothing narrower is honest', async () => {
    const dbPath = twoRuns().write(tempDbPath());
    harness = await serve(dbPath);

    const stream = await harness.stream();
    const first = await stream.next();

    expect(first.event.affected).toEqual({ all: true, runIds: [], unplaced: false });
  });

  it('names exactly the run a graph change touched, and no other', async () => {
    const dbPath = twoRuns().write(tempDbPath());
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    // A `ready → dispatched`-style flip: no message, no cursor movement — the change the
    // message delta alone could never surface, and the reason `affected` exists at all.
    writer.setTaskStatus('task_mine', 'completed');

    const push = await stream.next();
    expect(push.event.affected.all).toBe(false);
    expect(push.event.affected.runIds).toEqual([`run_${ORCHESTRATOR}`]);
    expect(push.event.affected.unplaced).toBe(false);
    expect(push.event.messages).toEqual([]);
  });

  it('names the run a new message lands in, beside the lossless delta itself', async () => {
    const dbPath = twoRuns().write(tempDbPath());
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    writer.message({
      fromHandle: WORKER,
      toHandle: ORCHESTRATOR,
      subject: 'Progress',
      payload: { taskId: 'task_mine' },
      createdAt: at(5 * MINUTE),
    });

    const push = await stream.next();
    expect(push.event.affected.runIds).toEqual([`run_${ORCHESTRATOR}`]);
    expect(push.event.messages.map((message) => message.subject)).toEqual(['Progress']);
  });

  it('flags evidence nothing places instead of naming every run — or none', async () => {
    const dbPath = twoRuns().write(tempDbPath());
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    // Handles no run has ever seen: attributable to nobody, honestly (SPEC §4.4, rule 3).
    writer.message({
      fromHandle: handleFor('sse-stranger'),
      toHandle: handleFor('sse-other-stranger'),
      subject: 'Lost',
      createdAt: at(6 * MINUTE),
    });

    const push = await stream.next();
    expect(push.event.affected.runIds).toEqual([]);
    expect(push.event.affected.unplaced).toBe(true);
  });

  it('recovers everything that happened while disconnected, without re-shipping history', async () => {
    const dbPath = twoRuns().write(tempDbPath());
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    const parting = await stream.next();
    await stream.close();

    // While nobody was listening: a message lands *and* a row is overwritten in place.
    writer.message({
      fromHandle: WORKER,
      toHandle: ORCHESTRATOR,
      subject: 'Missed me',
      payload: { taskId: 'task_mine' },
      createdAt: at(7 * MINUTE),
    });
    writer.setTaskStatus('task_other', 'failed');

    // The reconnect a browser makes: `Last-Event-ID` is the id of the last event it saw.
    const resumed = await harness.stream(Number(parting.id));
    const push = await resumed.next();

    // The message cursor is lossless — exactly the missed delta, not the whole feed…
    expect(push.event.messages.map((message) => message.subject)).toEqual(['Missed me']);
    // …and the graph side, which has no cursor, is claimed whole: the client refetches what it
    // displays — its loaded pages and its selected run — never the machine's history.
    expect(push.event.affected.all).toBe(true);
  });
});

describe('schema degradation survives the transport (#69)', () => {
  it('degrades the index and the snapshot by feature, never by refusing the request', async () => {
    // Pre-v4: no `created_by_terminal_handle`. Every task lands in the one synthetic run, and
    // the payloads still answer — with the reason on `meta.degraded`, not with a 500.
    const builder = new FixtureBuilder({ userVersion: 3 })
      .task({ id: 'task_a', handle: handleFor('ignored'), title: 'Old-world task', createdAt: at(0) })
      .task({ id: 'task_b', handle: handleFor('ignored-too'), title: 'Another', createdAt: at(MINUTE) });
    harness = await serve(builder.write(tempDbPath()));

    const page = await indexPage();
    expect(page.runs.map((run) => run.id)).toEqual(['run_unattributed']);
    expect(page.meta.degraded.some((reason) => reason.includes('created_by_terminal_handle'))).toBe(true);

    const snapshot = await runSnapshot('run_unattributed');
    expect(snapshot.tasks).toHaveLength(2);
    expect(snapshot.meta.degraded).toEqual(page.meta.degraded);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { selectFeed } from '../../src/client/feed/select.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { liveShapeCorpus } from '../fixtures/corpus.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * The feed's server half (#18): `StreamEvent.messages`, and the run each message belongs to.
 *
 * Attribution is the whole of it (SPEC §4.4), and it is the thing a naive implementation gets
 * quietly wrong — a message guessed into the wrong run is worse than one that admits it does
 * not know, because the user has no way to tell that it lied. So every rule below is asserted
 * from the outside, through `GET /api/snapshot`, against a database that really has the shape
 * the rule exists for.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60_000;

/** Minutes after the anchor, as a `Date` — the fixtures below are all relative to one instant. */
function at(minutes: number): Date {
  return new Date(AT.getTime() + minutes * MINUTE);
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('the feed', () => {
  it('carries every message the database holds, in sequence order', async () => {
    const coordinator = handleFor('coordinator');
    const worker = handleFor('worker');
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: coordinator, createdAt: AT });

    builder.message({ type: 'status', fromHandle: worker, toHandle: coordinator, subject: 'first', createdAt: at(1) });
    builder.message({ type: 'worker_done', fromHandle: worker, toHandle: coordinator, subject: 'second', createdAt: at(2) });

    harness = await serve(builder.write(tempDbPath()));

    const { messages } = await harness.snapshot();

    expect(messages.map((message) => message.subject)).toEqual(['first', 'second']);
    expect(messages.map((message) => message.sequence)).toEqual([1, 2]);
  });

  it('never puts the mailbox bookkeeping on the wire', async () => {
    // `read` and `delivered_at` are the two mutable flags on an otherwise-immutable row. They
    // are internal mailbox state, not orchestration semantics, and they are not rendered — so
    // they are not selected, and the client is never given the chance to render them (SPEC §6.3).
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: handleFor('c'), createdAt: AT });
    builder.message({
      fromHandle: handleFor('w'),
      toHandle: handleFor('c'),
      subject: 'a note',
      read: true,
      deliveredAt: at(1),
      createdAt: at(1),
    });

    harness = await serve(builder.write(tempDbPath()));

    const [message] = (await harness.snapshot()).messages;

    expect(message).toBeDefined();
    expect(Object.keys(message!)).not.toContain('read');
    expect(Object.keys(message!)).not.toContain('deliveredAt');
    // Not merely absent from the type — absent from the bytes. The row *has* both columns set.
    expect(JSON.stringify(message)).not.toContain('delivered');
  });

  it('normalizes the message timestamp to an ISO instant, like every other one', async () => {
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: handleFor('c'), createdAt: AT });
    builder.message({ fromHandle: handleFor('w'), toHandle: handleFor('c'), subject: 'note', createdAt: at(3) });

    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).messages[0]!.createdAt).toBe(at(3).toISOString());
  });

  it('parses the payload, so the client never has to know the column is TEXT', async () => {
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: handleFor('c'), createdAt: AT });
    builder.message({
      fromHandle: handleFor('w'),
      toHandle: handleFor('c'),
      subject: 'a gate',
      type: 'decision_gate',
      payload: { question: 'which way?', options: ['A', 'B'] },
      createdAt: at(1),
    });

    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).messages[0]!.payload).toEqual({ question: 'which way?', options: ['A', 'B'] });
  });
});

/**
 * Attribution (SPEC §4.4). `payload.taskId` carries 83% of it; the rest is handle membership
 * inside the run's time window; and what neither settles is left **null** rather than guessed.
 */
describe('message → run attribution', () => {
  it('follows payload.taskId to the task, and the task to its run', async () => {
    const coordinator = handleFor('coordinator');
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: coordinator, createdAt: AT });
    builder.message({
      type: 'worker_done',
      fromHandle: handleFor('worker'),
      toHandle: coordinator,
      subject: 'Done',
      payload: { taskId: 'task_a' },
      createdAt: at(5),
    });

    harness = await serve(builder.write(tempDbPath()));

    const snapshot = await harness.snapshot();
    const [message] = snapshot.messages;

    expect(message!.taskId).toBe('task_a');
    expect(message!.runId).toBe(snapshot.snapshot.tasks[0]!.runId);
  });

  it('keeps a message whose taskId names a task a reset deleted — unlinked, never dropped', async () => {
    // There are no foreign keys in this schema (SPEC §4.2, trap 8). A broken reference costs
    // the row its link to a node; it must not cost the row.
    const coordinator = handleFor('coordinator');
    const worker = handleFor('worker');
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: coordinator, createdAt: AT });
    builder.dispatch({ taskId: 'task_a', assigneeHandle: worker, status: 'completed', dispatchedAt: at(1) });
    builder.message({
      type: 'status',
      fromHandle: worker,
      toHandle: coordinator,
      subject: 'about a task that is gone',
      payload: { taskId: 'task_wiped_by_a_reset' },
      createdAt: at(5),
    });

    harness = await serve(builder.write(tempDbPath()));

    const [message] = (await harness.snapshot()).messages;

    expect(message!.subject).toBe('about a task that is gone');
    expect(message!.taskId).toBeNull();
  });

  it('falls back to the handles, inside the run window, when the payload names no task', async () => {
    const coordinator = handleFor('coordinator');
    const worker = handleFor('worker');
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: coordinator, createdAt: AT });
    builder.dispatch({ taskId: 'task_a', assigneeHandle: worker, status: 'dispatched', dispatchedAt: at(1) });
    builder.message({
      type: 'decision_gate',
      fromHandle: worker,
      toHandle: coordinator,
      subject: 'a gate with no taskId',
      payload: { question: 'which way?' },
      createdAt: at(5),
    });

    harness = await serve(builder.write(tempDbPath()));

    const snapshot = await harness.snapshot();
    const [message] = snapshot.messages;

    expect(message!.taskId).toBeNull();
    // The worker never created a task, so it is not a run *key* — it is a member of the run's
    // handle set through the dispatch context that assigned it the work.
    expect(message!.runId).toBe(snapshot.snapshot.runs[0]!.id);
  });

  it('uses the time window to tell two runs of the same terminal apart', async () => {
    // One handle, two runs — split by the six-hour idle gap (SPEC §4.3). Handle membership
    // alone matches both; the window is what decides which.
    const coordinator = handleFor('coordinator');
    const builder = new FixtureBuilder()
      .task({ id: 'task_first', handle: coordinator, createdAt: AT, completedAt: at(10) })
      .task({ id: 'task_second', handle: coordinator, createdAt: new Date(AT.getTime() + 9 * HOUR) });

    builder.message({
      fromHandle: coordinator,
      toHandle: handleFor('worker'),
      subject: 'during the first run',
      createdAt: at(5),
    });
    builder.message({
      fromHandle: coordinator,
      toHandle: handleFor('worker'),
      subject: 'during the second run',
      createdAt: new Date(AT.getTime() + 9 * HOUR + 5 * MINUTE),
    });

    harness = await serve(builder.write(tempDbPath()));

    const snapshot = await harness.snapshot();
    const runOf = (id: string) => snapshot.snapshot.tasks.find((task) => task.id === id)!.runId;
    const runIdBySubject = new Map(snapshot.messages.map((message) => [message.subject, message.runId]));

    expect(snapshot.snapshot.runs).toHaveLength(2);
    expect(runIdBySubject.get('during the first run')).toBe(runOf('task_first'));
    expect(runIdBySubject.get('during the second run')).toBe(runOf('task_second'));
  });

  it('leaves the run null when a handle shared by two live runs cannot be pinned to one', async () => {
    // Two coordinators, genuinely overlapping in time, and one worker terminal dispatched by
    // both. A message from that worker with no taskId belongs to *a* run, and nothing in the
    // schema says which. Null is the honest answer: it shows in "All" and is never guessed
    // into the wrong run.
    const first = handleFor('coordinator-1');
    const second = handleFor('coordinator-2');
    const shared = handleFor('shared-worker');

    const builder = new FixtureBuilder()
      .task({ id: 'task_1', handle: first, status: 'dispatched', createdAt: AT })
      .task({ id: 'task_2', handle: second, status: 'dispatched', createdAt: at(2) });

    builder.dispatch({ taskId: 'task_1', assigneeHandle: shared, status: 'dispatched', dispatchedAt: at(1) });
    builder.dispatch({ taskId: 'task_2', assigneeHandle: shared, status: 'dispatched', dispatchedAt: at(3) });

    builder.message({
      fromHandle: shared,
      toHandle: handleFor('somebody-else'),
      subject: 'which run is this?',
      createdAt: at(4),
    });

    harness = await serve(builder.write(tempDbPath()));

    const snapshot = await harness.snapshot();

    expect(snapshot.snapshot.runs).toHaveLength(2);
    expect(snapshot.messages[0]!.runId).toBeNull();
  });

  it('leaves the run null when neither handle belongs to any run', async () => {
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: handleFor('coordinator'), createdAt: AT });
    builder.message({
      fromHandle: handleFor('a-stranger'),
      toHandle: handleFor('another-stranger'),
      subject: 'from nowhere',
      createdAt: at(5),
    });

    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).messages[0]!.runId).toBeNull();
  });

  it('attributes a message that trails the run\'s last task, rather than losing it', async () => {
    // A live run's `endedAt` is its last task's *creation* — the work has not finished, so
    // nothing has completed. Every message the run then sends arrives after that instant, and
    // a window clamped hard to it would leave a running orchestration's own traffic
    // unattributed, which is precisely the case the feed exists to serve.
    const coordinator = handleFor('coordinator');
    const builder = new FixtureBuilder().task({
      id: 'task_a',
      handle: coordinator,
      status: 'dispatched',
      createdAt: AT,
    });

    builder.message({
      fromHandle: coordinator,
      toHandle: handleFor('worker'),
      subject: 'an hour into the work',
      createdAt: new Date(AT.getTime() + HOUR),
    });

    harness = await serve(builder.write(tempDbPath()));

    const snapshot = await harness.snapshot();

    expect(snapshot.messages[0]!.runId).toBe(snapshot.snapshot.runs[0]!.id);
  });
});

/**
 * Heartbeats are 65% of all traffic (SPEC §7.7) — and they are still *carried*. The filter is
 * the client's, because the toggle is: filtering them out of the payload would mean re-reading
 * the feed from the top whenever the user asked to see them, and the cursor's whole promise is
 * that what has been sent never has to be sent again.
 */
describe('heartbeats', () => {
  it('travels the wire, so the "show heartbeats" toggle costs no round trip', async () => {
    const coordinator = handleFor('coordinator');
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: coordinator, createdAt: AT });
    builder.message({
      type: 'heartbeat',
      fromHandle: handleFor('worker'),
      toHandle: coordinator,
      subject: 'alive',
      payload: { taskId: 'task_a' },
      createdAt: at(1),
    });

    harness = await serve(builder.write(tempDbPath()));

    expect((await harness.snapshot()).messages.map((message) => message.type)).toEqual(['heartbeat']);
  });

  it('is what the default feed hides — on a corpus that is 65% heartbeats, like the real one', async () => {
    // The whole ruling, asserted against the live shape rather than a toy: 466 messages, 302
    // of them heartbeats. Rendered straight, this feed is a heartbeat ticker. The default
    // content is the four types that are actually events — 164 rows over four days.
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { messages } = await harness.snapshot();
    const heartbeats = messages.filter((message) => message.type === 'heartbeat');

    expect(messages).toHaveLength(466);
    expect(heartbeats).toHaveLength(302);

    const { shown, hidden } = selectFeed(messages, { runId: null, showHeartbeats: false });

    expect(shown).toHaveLength(164);
    expect(hidden).toBe(302);
    // The default content, named: the four types that are actually events (SPEC §7.7).
    expect(new Set(shown.map((message) => message.type))).toEqual(
      new Set(['worker_done', 'decision_gate', 'escalation', 'status'])
    );
  });

  it('comes back when the toggle asks for it', async () => {
    harness = await serve(liveShapeCorpus().write(tempDbPath()));

    const { messages } = await harness.snapshot();
    const { shown, hidden } = selectFeed(messages, { runId: null, showHeartbeats: true });

    expect(shown).toHaveLength(466);
    expect(hidden).toBe(0);
  });
});

/**
 * The cursor is #17's and this ticket does not get a second one: the feed resumes from
 * `messages.sequence`, and a client that has seen everything is sent nothing.
 */
describe('the cursor', () => {
  it('sends only what is newer than the client has seen', async () => {
    const builder = new FixtureBuilder().task({ id: 'task_a', handle: handleFor('c'), createdAt: AT });
    for (let i = 1; i <= 4; i++) {
      builder.message({ fromHandle: handleFor('w'), toHandle: handleFor('c'), subject: `note ${i}`, createdAt: at(i) });
    }

    harness = await serve(builder.write(tempDbPath()));

    const stream = await harness.stream(2);
    const { event } = await stream.next();

    expect(event.messages.map((message) => message.subject)).toEqual(['note 3', 'note 4']);
    // The graph, though, comes whole every time: it is overwritten in place, so there is no
    // delta of it to trust (SPEC §6.3).
    expect(event.snapshot.tasks).toHaveLength(1);
  });
});

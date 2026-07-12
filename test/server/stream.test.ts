import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { FixtureWriter } from '../fixtures/writer.ts';
import { type Harness, serve } from './harness.ts';

/**
 * `GET /api/stream` (#17): the page keeps up with the agents.
 *
 * These tests are the only ones in the suite where the database **changes while the server
 * is reading it** — the test plays Orca, on its own connection (`FixtureWriter`), and the
 * server finds out the way it will in production: from `PRAGMA data_version`. Nothing here
 * tells the server that anything happened.
 *
 * The three properties, all of them about the wire:
 *
 * 1. A change produces one push, whose `seq` advanced and whose `messages` carry what is
 *    new and nothing older.
 * 2. **No change produces no push at all** — the `data_version` gate. An idle tick is not a
 *    push with an empty delta; it is silence.
 * 3. A reconnect replaying `Last-Event-ID` gets one full snapshot plus only what it missed,
 *    down the same code path as a normal tick.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const CODER = handleFor('coder');
const COORDINATOR = handleFor('coordinator');

let harness: Harness | undefined;
let writer: FixtureWriter | undefined;

afterEach(async () => {
  writer?.close();
  writer = undefined;
  await harness?.close();
  harness = undefined;
});

/** A run of two tasks with one message already in it, so there is a cursor to advance from. */
function fixture(): string {
  return new FixtureBuilder()
    .task({ id: 'task_build', handle: CODER, title: 'Build it', status: 'dispatched', createdAt: AT })
    .task({ id: 'task_ship', handle: CODER, title: 'Ship it', status: 'ready', deps: ['task_build'], createdAt: AT })
    .message({
      fromHandle: COORDINATOR,
      toHandle: CODER,
      subject: 'Build it',
      type: 'dispatch',
      payload: { taskId: 'task_build' },
      createdAt: AT,
    })
    .write(tempDbPath());
}

describe('GET /api/stream', () => {
  it('is SSE, and its first push is the same StreamEvent /api/snapshot returns', async () => {
    harness = await serve(fixture());

    const stream = await harness.stream();
    const push = await stream.next();

    // Same code path, asserted the only way that means anything: the two are the same event.
    expect(stream.contentType).toBe('text/event-stream');
    expect(push.event).toEqual(await harness.snapshot());

    // The SSE event id *is* the message high-water mark — which is what makes a browser's
    // automatic `Last-Event-ID` replay land on our cursor without a line of code.
    expect(push.id).toBe(String(push.event.seq));
  });

  it('pushes a new message, with the cursor advanced and nothing the client already had', async () => {
    const dbPath = fixture();
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    const first = await stream.next();
    expect(first.event.seq).toBe(1);
    expect(first.event.messages.map((message) => message.subject)).toEqual(['Build it']);

    // Orca gets on with it. Nothing tells the server; it finds out for itself.
    const sequence = writer.message({
      fromHandle: CODER,
      toHandle: COORDINATOR,
      subject: 'Built it',
      type: 'worker_done',
      body: 'the receipt',
      payload: { taskId: 'task_build' },
      createdAt: AT,
    });

    const push = await stream.next();

    // The cursor advanced, and it is the event id, so a reconnect resumes from exactly here.
    expect(sequence).toBe(2);
    expect(push.event.seq).toBe(2);
    expect(push.id).toBe('2');

    // The delta, and only the delta: the message the client already has is not sent twice.
    expect(push.event.messages).toHaveLength(1);
    expect(push.event.messages[0]).toMatchObject({
      sequence: 2,
      subject: 'Built it',
      type: 'worker_done',
      body: 'the receipt',
      fromHandle: CODER,
      toHandle: COORDINATOR,
      // `payload.taskId` is what 83% of attribution runs on: it links the message to a node.
      taskId: 'task_build',
    });

    // The graph, by contrast, comes whole every time — it is overwritten in place, so there
    // is no delta of it that could be trusted (SPEC §6.3).
    expect(push.event.snapshot.tasks).toHaveLength(2);
  });

  it('pushes a status flip that adds no message — the cursor stands still, the graph moves', async () => {
    const dbPath = fixture();
    harness = await serve(dbPath);
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    // The case that proves the two are different things: `data_version` moves and
    // `MAX(messages.sequence)` does not. A tool that polled on the cursor would show a
    // `ready → dispatched` flip never happening at all.
    writer.setTaskStatus('task_ship', 'dispatched');

    const push = await stream.next();

    expect(push.event.snapshot.tasks.find((task) => task.id === 'task_ship')?.status).toBe('dispatched');
    expect(push.event.seq).toBe(1);
    expect(push.event.messages).toEqual([]);
  });

  it('pushes nothing at all while the database does not change', async () => {
    harness = await serve(fixture());

    const stream = await harness.stream();
    await stream.next();

    // Twenty ticks at the 20 ms the harness polls at. An idle orchestration is silence, not a
    // push with an empty delta: no re-render, no flicker, and "something arrived" always means
    // something actually happened.
    await stream.quiet(400);
  });

  it('resumes from Last-Event-ID with one snapshot and only what came after it', async () => {
    const dbPath = fixture();
    writer = new FixtureWriter(dbPath);

    // Two more messages land while nobody is connected — a browser asleep, a laptop lid shut.
    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Halfway', createdAt: AT });
    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });
    harness = await serve(dbPath);

    // Exactly what a reconnecting `EventSource` sends, in the header it sends it in.
    const stream = await harness.stream(1);
    const push = await stream.next();

    // One full snapshot — the graph is never a delta — plus only the messages after sequence 1.
    expect(push.event.snapshot.tasks).toHaveLength(2);
    expect(push.event.snapshot.runs).toHaveLength(1);
    expect(push.event.messages.map((message) => message.sequence)).toEqual([2, 3]);
    expect(push.event.messages.map((message) => message.subject)).toEqual(['Halfway', 'Built it']);

    // Same code path as a normal tick, so the id is the same high-water mark it always is.
    expect(push.event.seq).toBe(3);
    expect(push.id).toBe('3');
  });

  it('flips the badge to stale when Orca is closed, though the database never changes again', async () => {
    const dbPath = fixture();
    writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));

    let orcaIsRunning = true;
    harness = await serve(dbPath, { probe: () => orcaIsRunning });

    const stream = await harness.stream();
    expect((await stream.next()).event.meta.liveness).toBe('live');

    // The user quits Orca. Nothing writes to the database, because the process that writes to
    // it is *gone* — so `data_version` will never move again. A push gated on the database
    // alone would leave a green "connected to running Orca" dot on screen for ever, which is
    // this tool's worst lie (SPEC §7.3). Liveness is therefore re-read every tick, and a
    // change in it is a change worth pushing — it costs a stat and a signal-0, not a query.
    orcaIsRunning = false;

    const push = await stream.next();

    expect(push.event.meta.liveness).toBe('stale');
    expect(push.event.meta.orcaPid).toBe(4242);
    // ...and everything else keeps working: the run, its DAG, and the feed are all still there.
    expect(push.event.snapshot.tasks).toHaveLength(2);
    expect(push.event.messages).toEqual([]);
    expect(push.event.seq).toBe(1);
  });
});

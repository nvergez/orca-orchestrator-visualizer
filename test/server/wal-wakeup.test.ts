import { existsSync, utimesSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { FixtureWriter } from '../fixtures/writer.ts';
import { type Harness, serve } from './harness.ts';

/**
 * The wake hint, end to end (#59): the real server over real HTTP, a real WAL database
 * changing under it, and `fs.watch` — not the test — telling the poll to look early.
 *
 * The trick every positive test here leans on is a poll interval of **ten minutes**: any
 * push that arrives inside a two-second timeout cannot have come from the interval, so an
 * arriving push *is* the woken path, observed on the wire. The negative half is the same
 * gate the poll always had: a hint against an unchanged `data_version` pushes nothing.
 *
 * What none of this may change is correctness with the watcher gone: setup failure, runtime
 * failure and plain absence of the flag all leave the fixed poll delivering exactly what it
 * always delivered.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const CODER = handleFor('coder');
const COORDINATOR = handleFor('coordinator');

/** Long enough that the interval cannot fire inside a test: a push within seconds is the wake. */
const NEVER_POLLS_MS = 600_000;

let harnesses: Harness[] = [];
let writer: FixtureWriter | undefined;
let errorSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(async () => {
  writer?.close();
  writer = undefined;
  await Promise.all(harnesses.map((harness) => harness.close()));
  harnesses = [];
  errorSpy?.mockRestore();
  errorSpy = undefined;
});

async function serveTracked(...args: Parameters<typeof serve>): Promise<Harness> {
  const harness = await serve(...args);
  harnesses.push(harness);
  return harness;
}

/** The stream fixture: two tasks, one message, so both the graph and the cursor can move. */
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

describe('the WAL wake hint (--watch)', () => {
  it('wakes the poll early: a change surfaces long before the interval could fire', async () => {
    const dbPath = fixture();
    const harness = await serveTracked(dbPath, { watch: {}, pollIntervalMs: NEVER_POLLS_MS });
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });

    // Ten minutes of interval stand between this write and the next scheduled tick. The push
    // arriving now is the watcher scheduling that tick early — the whole feature, on the wire.
    const push = await stream.next();
    expect(push.event.seq).toBe(2);
    expect(push.event.messages.map((message) => message.subject)).toEqual(['Built it']);
  });

  it('emits the same snapshot contents whether the tick was woken or scheduled', async () => {
    const dbPath = fixture();
    // Two servers, one database: one relies on its (fast) interval, the other can only have
    // been woken. Equivalence is then literal — the same event, byte for byte, because a
    // woken tick *is* the normal tick, not a second read path.
    const polled = await serveTracked(dbPath, { pollIntervalMs: 20 });
    const woken = await serveTracked(dbPath, { watch: {}, pollIntervalMs: NEVER_POLLS_MS });
    writer = new FixtureWriter(dbPath);

    const polledStream = await polled.stream();
    const wokenStream = await woken.stream();
    expect((await wokenStream.next()).event).toEqual((await polledStream.next()).event);

    // One commit, deliberately: two separate commits could straddle a fast tick and reach the
    // polled stream as two pushes, and this test is about *what* a push holds, not how many.
    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });

    const polledPush = await polledStream.next();
    const wokenPush = await wokenStream.next();

    expect(wokenPush.event).toEqual(polledPush.event);
    expect(wokenPush.id).toBe(polledPush.id);
  });

  it('pushes nothing on a hint whose data_version is unchanged — and is still awake after it', async () => {
    const dbPath = fixture();
    const harness = await serveTracked(dbPath, { watch: {}, pollIntervalMs: NEVER_POLLS_MS });
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    // A file event that is not a commit: the mtime moves, `data_version` does not. The hint
    // runs the normal check and stops at its gate — no snapshot, no push (the "no queries"
    // half of that promise is counted at the gate's own seam in stream.test.ts, where a
    // tick against an unchanged version provably never reads a table).
    utimesSync(dbPath, new Date(), new Date());
    await stream.quiet(600);

    // The no-op hint cost the watcher nothing: the next real commit still wakes the poll.
    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });
    expect((await stream.next()).event.seq).toBe(2);
  });

  it('starts before any -wal exists and hears the one a new writer creates', async () => {
    // The builder closes its connection, so the fixture sits checkpointed: no -wal on disk.
    // This is exactly the post-mortem shape — orca-viz running, Orca closed — and the file
    // the watcher must hear about is one that did not exist when watching began.
    const dbPath = fixture();
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    const harness = await serveTracked(dbPath, { watch: {}, pollIntervalMs: NEVER_POLLS_MS });
    const stream = await harness.stream();
    await stream.next();

    // Orca launches and commits: a brand-new -wal is born and grows.
    writer = new FixtureWriter(dbPath);
    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });

    const push = await stream.next();
    expect(push.event.messages.map((message) => message.subject)).toEqual(['Built it']);
  });

  it('keeps the fixed poll running while the watcher is alive and healthy', async () => {
    const dbPath = fixture();
    // A debounce of a minute gags the wake path without disabling the watcher: any push now
    // is the interval's. `--watch` adds a wake; it must never subtract the poll.
    const harness = await serveTracked(dbPath, { watch: { debounceMs: 60_000 }, pollIntervalMs: 20 });
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });
    expect((await stream.next()).event.seq).toBe(2);
  });

  it('warns once and keeps delivering by poll when the watch cannot start', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dbPath = fixture();
    const harness = await serveTracked(dbPath, {
      watch: {
        watchImpl: () => {
          throw new Error('EMFILE: too many open files');
        },
      },
      pollIntervalMs: 20,
    });
    writer = new FixtureWriter(dbPath);

    // The failure cost a warning and the latency — never the data.
    const stream = await harness.stream();
    const first = await stream.next();
    expect(first.event.snapshot.tasks).toHaveLength(2);

    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });
    expect((await stream.next()).event.seq).toBe(2);

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('poll');
  });

  it('warns once and keeps delivering by poll when the watcher dies at runtime', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = Object.assign(new EventEmitter(), {
      close(): void {},
      unref(): void {},
    });

    const dbPath = fixture();
    const harness = await serveTracked(dbPath, { watch: { watchImpl: () => fake }, pollIntervalMs: 20 });
    writer = new FixtureWriter(dbPath);

    const stream = await harness.stream();
    await stream.next();

    fake.emit('error', new Error('EMFILE: too many open files'));
    fake.emit('error', new Error('EMFILE: still too many'));

    writer.message({ fromHandle: CODER, toHandle: COORDINATOR, subject: 'Built it', createdAt: AT });
    expect((await stream.next()).event.seq).toBe(2);

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

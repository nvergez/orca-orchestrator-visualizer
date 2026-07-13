import { EventEmitter } from 'node:events';
import { appendFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type WakeWatcher, watchForWakeHints } from '../../src/server/wake.ts';
import { tempDir } from '../fixtures/temp-dir.ts';

/**
 * The wake hint (#59): a filesystem watcher that may call the poll early, and nothing else.
 *
 * These tests stand at the watcher's own seam — a real directory, real `fs.watch` events —
 * and assert the three properties the ticket hangs on: a burst of WAL writes becomes **one**
 * wake, the watcher observes the *directory* (so a `-wal` that is deleted and recreated is
 * still seen), and every failure warns once and degrades to nothing rather than throwing.
 * What a wake *does* is not this module's business: it calls a callback, and the poll's
 * `data_version` gate owns everything after that (`test/server/wal-wakeup.test.ts`).
 */

/** The debounce, shrunk the same way the harness shrinks the poll interval. */
const DEBOUNCE_MS = 25;

/** Wait for `condition` the way the SSE helper waits for a push: patiently, with a deadline. */
async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Resolves only if `wakes` never moves for `ms` — the negative, asserted the quiet() way. */
async function quiet(count: () => number, ms: number): Promise<void> {
  const before = count();
  await new Promise((resolve) => setTimeout(resolve, ms));
  const after = count();
  if (after !== before) throw new Error(`expected no wake, but ${after - before} arrived`);
}

/** A stand-in for `fs.watch` whose failures the test gets to script. */
class FakeWatcher extends EventEmitter {
  closed = false;
  close(): void {
    this.closed = true;
  }
  unref(): this {
    return this;
  }
}

let watcher: WakeWatcher | undefined;
let errorSpy: ReturnType<typeof vi.spyOn> | undefined;

afterEach(() => {
  watcher?.close();
  watcher = undefined;
  errorSpy?.mockRestore();
  errorSpy = undefined;
});

/** A directory holding a database the way Orca leaves one mid-run: main file, `-wal`, `-shm`. */
function databaseDir(): { dir: string; dbPath: string } {
  const dir = tempDir();
  const dbPath = join(dir, 'orchestration.db');
  writeFileSync(dbPath, 'main');
  writeFileSync(`${dbPath}-wal`, 'wal');
  writeFileSync(`${dbPath}-shm`, 'shm');
  return { dir, dbPath };
}

describe('watchForWakeHints', () => {
  it('debounces a burst of WAL appends into one wake', async () => {
    const { dbPath } = databaseDir();
    let wakes = 0;
    // A wider debounce than the other tests use: this one asserts *exactly one* wake, and a
    // suite running under load can hold an fs event back long enough to slip a 25 ms window.
    watcher = watchForWakeHints(dbPath, () => wakes++, { debounceMs: 100 });

    // Orca commits: several writes land on the -wal in quick succession. One transaction is
    // one early poll, not five of them.
    for (let i = 0; i < 5; i++) appendFileSync(`${dbPath}-wal`, `frame ${i}`);

    await waitFor(() => wakes === 1);
    await quiet(() => wakes, 150);
  });

  it('ignores files that are not the database or its WAL/SHM siblings', async () => {
    const { dir, dbPath } = databaseDir();
    let wakes = 0;
    watcher = watchForWakeHints(dbPath, () => wakes++, { debounceMs: DEBOUNCE_MS });

    // The directory is Orca's whole userData root: logs, config and orca-runtime.json churn
    // in it constantly, and none of that is a database change.
    writeFileSync(join(dir, 'orca-runtime.json'), '{"pid":4242}');
    writeFileSync(join(dir, 'window-state.json'), '{}');

    await quiet(() => wakes, 150);
  });

  it('keeps watching across WAL deletion and recreation — the directory, not a file descriptor', async () => {
    const { dbPath } = databaseDir();
    let wakes = 0;
    watcher = watchForWakeHints(dbPath, () => wakes++, { debounceMs: DEBOUNCE_MS });

    appendFileSync(`${dbPath}-wal`, 'before shutdown');
    await waitFor(() => wakes >= 1);

    // A clean Orca shutdown deletes the -wal and -shm; the next launch recreates them. A
    // watcher holding the -wal's file descriptor is stranded here; one holding the directory
    // is not — which is the entire reason the directory is what gets watched.
    rmSync(`${dbPath}-wal`);
    rmSync(`${dbPath}-shm`);
    const seenBeforeRecreation = wakes;

    await new Promise((resolve) => setTimeout(resolve, 100));
    writeFileSync(`${dbPath}-wal`, 'a new instance');
    appendFileSync(`${dbPath}-wal`, 'and a commit');

    await waitFor(() => wakes > seenBeforeRecreation);
  });

  it('treats an event with no filename as a hint rather than dropping it', async () => {
    // Some platforms deliver events without saying which file moved. A hint is cheap — one
    // pragma behind the debounce — and dropping it silently is a stall on exactly the
    // platforms that already have the worst watch semantics.
    const fake = new FakeWatcher();
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    let wakes = 0;

    watcher = watchForWakeHints('/data/orchestration.db', () => wakes++, {
      debounceMs: DEBOUNCE_MS,
      watchImpl: (_directory, onEvent) => {
        listener = onEvent;
        return fake;
      },
    });

    listener?.('change', null);
    await waitFor(() => wakes === 1);
  });

  it('warns once and degrades to nothing when watching cannot start', () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let wakes = 0;

    // A directory fs.watch cannot take: does not exist, EMFILE, an unsupported filesystem.
    watcher = watchForWakeHints(join(tempDir(), 'gone', 'orchestration.db'), () => wakes++, {
      debounceMs: DEBOUNCE_MS,
    });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('poll');

    // Degraded means inert, not broken: closing the husk is still fine.
    watcher.close();
    expect(wakes).toBe(0);
  });

  it('warns once — not per event — when the watcher dies at runtime, and closes it', async () => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = new FakeWatcher();
    let wakes = 0;

    watcher = watchForWakeHints('/data/orchestration.db', () => wakes++, {
      debounceMs: DEBOUNCE_MS,
      watchImpl: () => fake,
    });

    fake.emit('error', new Error('EMFILE: too many open files'));
    fake.emit('error', new Error('EMFILE: still too many'));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('poll');
    expect(fake.closed).toBe(true);
    await quiet(() => wakes, 100);
  });

  it('wakes nobody after close, even with a hint already in flight', async () => {
    const fake = new FakeWatcher();
    let listener: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    let wakes = 0;

    watcher = watchForWakeHints('/data/orchestration.db', () => wakes++, {
      debounceMs: DEBOUNCE_MS,
      watchImpl: (_directory, onEvent) => {
        listener = onEvent;
        return fake;
      },
    });

    // A hint lands, and the server shuts down before the debounce fires. The wake must die
    // with the watcher: a tick against a closed database is a crash, not a no-op.
    listener?.('change', 'orchestration.db-wal');
    watcher.close();
    watcher = undefined;

    expect(fake.closed).toBe(true);
    await quiet(() => wakes, 100);

    // And a straggler event from an already-closed impl schedules nothing either.
    listener?.('change', 'orchestration.db-wal');
    await quiet(() => wakes, 100);
  });
});

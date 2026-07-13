import { watch as fsWatch } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * The optional wake hint (#59): `--watch` puts a filesystem watcher beside the poll loop, and
 * the only thing a watcher event may ever do is run the normal tick early.
 *
 * The poll stays authoritative. A tick — woken or scheduled — still opens with the `PRAGMA
 * data_version` gate, so a hint that turns out to be nothing costs one pragma and pushes no
 * snapshot; and the fixed interval keeps firing whether the watcher lives or dies, so the
 * worst a broken watch can cost is the latency it was bought for. No watcher event is ever
 * itself a fact: files are touched by checkpoints, recoveries and passing daemons, and only
 * SQLite knows whether any of it committed.
 *
 * Two decisions carry the reliability:
 *
 * - **The *directory* is watched, never the `-wal` itself.** A clean Orca shutdown deletes
 *   the `-wal`/`-shm`, and the next launch recreates them — a watcher holding the old file's
 *   descriptor is stranded forever, while one holding the directory sees the new files being
 *   born. Events are then filtered back down to the three names that are the database.
 * - **Failure is a warning, once, and then polling as if the flag had never been passed.**
 *   `fs.watch` is the most platform-bent API in Node; a tool that crashed on its moods would
 *   have traded correctness for latency, which is the exact trade this ticket forbids.
 *
 * What the browser sees of any of this is nothing new: a woken push is an ordinary
 * `StreamEvent`, and the page's "Data age" readout (#57) — which restarts on every applied
 * snapshot — is what makes the earlier arrival observable, without a word of delivery
 * guarantee anywhere.
 */

/** How long a burst gets to finish before the wake fires. One commit is many file events. */
const WAKE_DEBOUNCE_MS = 150;

/** What this module needs from `fs.watch` — injectable, so a test can script its failures. */
export type WatchImpl = (
  directory: string,
  onEvent: (eventType: string, filename: string | Buffer | null) => void
) => {
  on(event: 'error', listener: (error: Error) => void): unknown;
  close(): void;
  unref(): unknown;
};

export type WakeDeps = {
  debounceMs?: number;
  watchImpl?: WatchImpl;
};

/** A running (or already-degraded) watcher. `close()` is always safe to call. */
export type WakeWatcher = { close(): void };

/** The degraded state: watching failed, the warning is printed, polling owns the job alone. */
const INERT: WakeWatcher = { close() {} };

/**
 * Watch the directory around `dbPath` and call `wake` — debounced — whenever the database or
 * its `-wal`/`-shm` siblings change. Never throws: a watch that cannot start warns once and
 * returns an inert watcher, because the caller's poll loop is the feature and this is only
 * its accelerator.
 */
export function watchForWakeHints(dbPath: string, wake: () => void, deps: WakeDeps = {}): WakeWatcher {
  const { debounceMs = WAKE_DEBOUNCE_MS, watchImpl = fsWatch } = deps;
  const directory = dirname(dbPath);
  const database = basename(dbPath);
  const names = new Set([database, `${database}-wal`, `${database}-shm`]);

  let pending: NodeJS.Timeout | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    if (pending !== null) clearTimeout(pending);
    pending = null;
    watcher.close();
  };

  const hint = (filename: string | Buffer | null) => {
    // No filename is a platform being vague, not a file being irrelevant — take the hint.
    if (filename !== null && !names.has(filename.toString())) return;
    // A pending wake absorbs the rest of the burst. Absorbing (rather than resetting the
    // timer) also means a write storm cannot postpone the wake indefinitely.
    if (closed || pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      wake();
    }, debounceMs);
    pending.unref();
  };

  let watcher: ReturnType<WatchImpl>;
  try {
    watcher = watchImpl(directory, (_eventType, filename) => hint(filename));
  } catch (error) {
    warnFallingBack(directory, error);
    return INERT;
  }

  // Neither the watcher nor a scheduled wake may be the reason the process stays up.
  watcher.unref();

  watcher.on('error', (error) => {
    // Said once — the whole story is "watching is over, polling continues", and there is no
    // second thing a second error could add to it.
    if (closed) return;
    warnFallingBack(directory, error);
    close();
  });

  return { close };
}

function warnFallingBack(directory: string, error: unknown): void {
  console.error(
    `orca-viz: cannot watch ${directory} for changes — ${(error as Error).message}. ` +
      'Falling back to the poll alone; updates surface on its normal cadence.'
  );
}

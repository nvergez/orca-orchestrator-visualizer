import type { Liveness, StreamEvent } from '../shared/types.ts';

/**
 * The poll loop, and the browsers listening to it (SPEC §6.1–6.2).
 *
 * A fixed `setInterval` — 5000 ms, `--poll-interval` overrides — **gated on `PRAGMA
 * data_version`**. That gate is the whole design:
 *
 * - **`data_version` is the change detector.** Unchanged means *skip everything*: no
 *   queries, no push. An idle orchestration costs one pragma every five seconds, and the
 *   browser never receives a no-op — so a push always means something actually happened.
 * - **`MAX(messages.sequence)` is the cursor, not the detector.** The two are not
 *   interchangeable, and confusing them is the bug this loop is written to make impossible:
 *   a `ready → dispatched` flip moves `data_version` and leaves `sequence` exactly where it
 *   was. Detect with one, resume with the other.
 * - **`fs.watch` never replaces any of this — it may only hurry it** (#59). By default there
 *   is no watcher at all; `--watch` adds one (`wake.ts`) whose entire authority is to call
 *   `tick()` early. A woken tick meets the same `data_version` gate a scheduled one does, so
 *   a file event that committed nothing still costs one pragma and pushes nothing — and a
 *   watcher that dies leaves this interval exactly as it was.
 * - **Liveness is the second half of the gate**, because it is the one thing that changes
 *   without the database changing. Quitting Orca cannot announce itself in the file — the
 *   process that writes the file is the one that just died — so a loop gated on
 *   `data_version` alone would freeze the badge at "live" precisely when it turns false. It
 *   is re-read every tick (SPEC §6.1) and it is not a query: a stat and a signal-0.
 *
 * The accepted trade (SPEC §6.1): 5 s is 2.5× Orca's own coordinator cadence, so a status
 * flip can surface up to 5 s late. Deliberate — a watch-my-agents panel that is slightly
 * behind is fine; one that spins the fan is not.
 *
 * Every push — first connect, tick, reconnect — is one `StreamEvent` built by one call to
 * `snapshot(cursor)`. There is no resync mode, because there is nothing for a resync mode
 * to do differently.
 */

/** All the loop needs from a database — which is what lets a test hand it a counting stub. */
export type StreamSource = {
  dataVersion(): number;
  liveness(): Liveness;
  snapshot(since?: number): StreamEvent;
};

/** One connected browser, as this module sees it: something to push to, and to close. */
export type StreamClient = {
  send(event: StreamEvent): void;
  end(): void;
};

type Subscriber = {
  client: StreamClient;
  /** The highest `sequence` this client has been sent — its `Last-Event-ID`, kept current. */
  cursor: number;
  /** The `data_version` the client's view was built from. Different ⇒ it is out of date. */
  version: number;
  /** The liveness it was built from. Orca quitting changes this and *nothing else*. */
  liveness: Liveness;
};

export class EventStream {
  private readonly source: StreamSource;
  private readonly pollIntervalMs: number;
  private readonly subscribers = new Set<Subscriber>();
  private timer: NodeJS.Timeout | null = null;
  /** A failing database logs once, not every five seconds until the user quits. */
  private failing = false;

  constructor(source: StreamSource, pollIntervalMs: number) {
    this.source = source;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Attach a browser and push it its first event immediately: one full snapshot plus every
   * message after `since`.
   *
   * On a fresh connect `since` is 0 and that is the whole feed. On a reconnect it is the
   * `Last-Event-ID` the browser replayed, and the event carries exactly what was missed. It
   * is the same call either way — *the same call a tick makes* — which is why there is no
   * resync path here to get wrong.
   *
   * `since` is already a cursor: the HTTP edge (`server.ts`) is what turns an untrusted
   * `Last-Event-ID` header into one, and it is the only place that gets to decide what a
   * bad one means.
   *
   * Throws whatever the first read throws, and registers nothing when it does, so the caller
   * can still answer with an HTTP error instead of an SSE stream that never speaks. The first
   * *send* can throw too — a browser that hung up while we were reading — and that unregisters
   * again rather than leaving the loop polling SQLite on behalf of a socket that is gone.
   */
  subscribe(client: StreamClient, since = 0): () => void {
    const version = this.source.dataVersion();
    const event = this.source.snapshot(since);

    const subscriber: Subscriber = { client, cursor: since, version, liveness: event.meta.liveness };
    this.subscribers.add(subscriber);
    this.start();

    try {
      this.deliver(subscriber, event);
    } catch (error) {
      this.drop(subscriber);
      throw error;
    }

    return () => this.drop(subscriber);
  }

  /**
   * One tick. Public because the gate is the ticket: a test hands this class a counting
   * `StreamSource` and demands a tick, which is the only way to assert that an unchanged
   * `data_version` costs *no queries* — and not merely no push (`test/server/stream.test.ts`).
   */
  tick(): void {
    if (this.subscribers.size === 0) return;

    let version: number;
    let event: StreamEvent;
    let stale: Subscriber[];

    // Only the *reads* are guarded. The file can be deleted, or checkpointed out from under
    // us, and a throw inside a `setInterval` is an unhandled exception that would take the
    // whole tool down mid-poll — so a failed read is swallowed, said once, and retried on the
    // next tick. Nothing here has touched a subscriber yet, so their `version` is unchanged
    // and a recovery pushes them everything they missed.
    try {
      // The two things that can have changed under us, and the *only* two reads an idle tick
      // makes: SQLite's commit counter, and whether Orca is still alive. One pragma, one stat,
      // one signal-0 — no queries against a single table, and nothing at all sent to the browser.
      version = this.source.dataVersion();
      const liveness = this.source.liveness();

      // Those two reads succeeding *is* the recovery: the file is readable again. Reset here
      // rather than after a successful push, or a database that failed and then came back to
      // an idle orchestration would never re-arm — and the *next* failure would be silent.
      this.failing = false;

      stale = [...this.subscribers].filter(
        (subscriber) => subscriber.version !== version || subscriber.liveness !== liveness
      );
      if (stale.length === 0) return;

      // Read the graph once, from the oldest cursor among the clients that need it, and give
      // each client the slice it has not seen. Two tabs are not two round trips to SQLite.
      event = this.source.snapshot(Math.min(...stale.map((subscriber) => subscriber.cursor)));
    } catch (error) {
      this.reportFailure(error);
      return;
    }

    for (const subscriber of stale) {
      // Delivered *first*, and marked current only once it lands. The other order marks a
      // client up to date with an event a broken socket swallowed, and it then sits silently
      // stale until some unrelated write happens to move `data_version` again.
      //
      // A write that throws is a browser that is gone, not a database that is broken: it is
      // this one client's stream that ends, and neither the other subscribers' push nor the
      // poll loop itself is allowed to fail with it.
      try {
        this.deliver(subscriber, event);
      } catch {
        this.drop(subscriber);
        continue;
      }

      // The version we *read before the snapshot*, never one read after it: a write landing
      // mid-read then leaves us holding the older version, so the next tick sees a change and
      // pushes again. The other order would record a version this snapshot never saw and lose
      // that change forever — a client silently stale until the next unrelated write.
      subscriber.version = version;
      // Liveness, though, is taken from the event we actually sent: `snapshot()` re-derives
      // it, and recording the one *we* read a moment earlier would leave the two disagreeing
      // and push a duplicate on the next tick.
      subscriber.liveness = event.meta.liveness;
    }
  }

  /** End every open stream and stop polling. The server calls this before it stops listening. */
  close(): void {
    this.stopTimer();
    for (const subscriber of this.subscribers) subscriber.client.end();
    this.subscribers.clear();
  }

  private deliver(subscriber: Subscriber, event: StreamEvent): void {
    const messages = event.messages.filter((message) => message.sequence > subscriber.cursor);
    subscriber.client.send(messages.length === event.messages.length ? event : { ...event, messages });

    // The cursor is exactly the id we just put on the wire, because that id is what the browser
    // will replay to us as `Last-Event-ID`. The two must not be allowed to disagree.
    //
    // Which decides the one case where they could: a client resuming from a sequence *ahead* of
    // everything the file holds — a database restored from a backup, replaced, or reset. Keeping
    // the higher cursor there (`Math.max`) would filter every future message out for the life of
    // that connection, and the stream would simply never speak again. So the cursor follows the
    // file down, and the client picks up from the real high-water mark. `meta.resetDetected` is
    // how the user is told that the history behind it is gone.
    subscriber.cursor = event.seq;
  }

  /** One client gone: unregistered, and — if it was the last — the poll loop with it. */
  private drop(subscriber: Subscriber): void {
    this.subscribers.delete(subscriber);
    // Nobody listening is not a slow loop, it is no loop: the pragma stops being read at all.
    if (this.subscribers.size === 0) this.stopTimer();
  }

  /** A failing database says so once, not every five seconds until the user gives up and quits. */
  private reportFailure(error: unknown): void {
    if (this.failing) return;
    this.failing = true;
    console.error(`orca-viz: could not read the database — ${(error as Error).message}`);
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.pollIntervalMs);
    // A loop nobody is listening to must never be the reason a process stays up.
    this.timer.unref();
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

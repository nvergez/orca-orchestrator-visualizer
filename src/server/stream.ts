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
 * - **No `fs.watch` on the `-wal`.** It is deleted on clean Orca shutdown, its semantics
 *   vary per platform, and at a 5 s cadence it buys nothing.
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
   * Throws whatever the first read throws, **before** the client is registered, so the
   * caller can still answer with an HTTP error instead of an SSE stream that never speaks.
   */
  subscribe(client: StreamClient, since = 0): () => void {
    const cursor = Number.isInteger(since) && since > 0 ? since : 0;
    const version = this.source.dataVersion();
    const event = this.source.snapshot(cursor);

    const subscriber: Subscriber = { client, cursor, version, liveness: event.meta.liveness };
    this.subscribers.add(subscriber);
    this.start();
    this.deliver(subscriber, event);

    return () => {
      this.subscribers.delete(subscriber);
      // Nobody listening is not a slow loop, it is no loop: the pragma stops being read at all.
      if (this.subscribers.size === 0) this.stopTimer();
    };
  }

  /**
   * One tick. Public because the gate is the ticket, and a test should be able to demand a
   * tick and watch nothing happen rather than sleep and hope.
   */
  tick(): void {
    if (this.subscribers.size === 0) return;

    try {
      // The two things that can have changed under us, and the *only* two reads an idle tick
      // makes: SQLite's commit counter, and whether Orca is still alive. One pragma, one stat,
      // one signal-0 — no queries against a single table, and nothing at all sent to the browser.
      const version = this.source.dataVersion();
      const liveness = this.source.liveness();

      // Those two reads succeeding *is* the recovery: the file is readable again. Reset here
      // rather than after a successful push, or a database that failed and then came back to
      // an idle orchestration would never re-arm — and the *next* failure would be silent.
      this.failing = false;

      const stale = [...this.subscribers].filter(
        (subscriber) => subscriber.version !== version || subscriber.liveness !== liveness
      );
      if (stale.length === 0) return;

      // Read the graph once, from the oldest cursor among the clients that need it, and give
      // each client the slice it has not seen. Two tabs are not two round trips to SQLite.
      const event = this.source.snapshot(Math.min(...stale.map((subscriber) => subscriber.cursor)));

      for (const subscriber of stale) {
        // The version we *read before the snapshot*, never one read after it: a write landing
        // mid-read then leaves us holding the older version, so the next tick sees a change and
        // pushes again. The other order would record a version this snapshot never saw and lose
        // that change forever — a client silently stale until the next unrelated write.
        subscriber.version = version;
        // Liveness, though, is taken from the event we actually sent: `snapshot()` re-derives
        // it, and recording the one *we* read a moment earlier would leave the two disagreeing
        // and push a duplicate on the next tick.
        subscriber.liveness = event.meta.liveness;
        this.deliver(subscriber, event);
      }
    } catch (error) {
      // The file can be deleted, or checkpointed out from under a read. A throw inside a
      // `setInterval` is an unhandled exception that takes the whole tool down mid-poll —
      // so the tick swallows it, says so once, and tries again in five seconds. The clients
      // stay connected and their `version` is unchanged, so a recovery pushes what they missed.
      if (!this.failing) {
        this.failing = true;
        console.error(`orca-viz: could not read the database — ${(error as Error).message}`);
      }
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

    // Never backwards. A `Last-Event-ID` from before an `orchestration reset` can be *ahead*
    // of everything the file still holds; rewinding the cursor there would replay old messages
    // as though they were new. `meta.resetDetected` is how the user is told the history is gone.
    subscriber.cursor = Math.max(subscriber.cursor, event.seq);
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

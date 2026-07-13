import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '../shared/types.ts';
import { App } from './App.tsx';

/**
 * The transport — an `EventSource` on `/api/stream`, feeding `<App>` (#17).
 *
 * It is kept out of `<App>` on purpose, and that is the whole architecture of the client:
 * everything the shell renders arrives through its props, so `<App>` is testable against a canned
 * event (seam 2, #12) and the network lives at the edges. There are exactly two of those, and the
 * other is the inspector's one-shot `GET /api/task/:id` (`inspector/detail.ts`, #20) — which is a
 * *loader value* the shell is handed, defaulting to the real fetch, precisely so that the click
 * that asks for a 172 KB body is a thing a test can watch happen.
 *
 * **Why there is so little code here.** `EventSource` reconnects on its own, and replays the
 * `Last-Event-ID` of the last event it saw. That id *is* `MAX(messages.sequence)` — the
 * server's cursor — so the resume story is the browser's, not ours: no retry timer, no
 * backoff, no "am I stale?" bookkeeping, and no resync mode to get wrong. A dropped
 * connection comes back with one full snapshot plus exactly what was missed, down the same
 * code path as any other tick. The right amount of code for that is none, and this is it.
 *
 * Every push is a whole `StreamEvent`, so the state is a replacement and never a merge: the
 * graph is re-sent whole because it is overwritten in place (SPEC §6.3). `event.messages` is
 * the delta after the client's cursor, and **it is not accumulated here** — what little the page
 * still remembers of it lives with the thing that uses it (`conversation/pulses.ts`), so this file
 * stays the one that knows a network exists and nothing more.
 */

export function Live() {
  const { event, epoch } = useStream();

  return <App event={event} streamEpoch={epoch} />;
}

/**
 * The latest `StreamEvent` the server has pushed, and **which connection pushed it**.
 *
 * The event is the page. The `epoch` is one fact about the *transport* that one thing on the page
 * genuinely needs: it counts the connections, so the shell can tell a normal tick from the first
 * snapshot after a reconnect. That snapshot is a full re-read of everything that happened while
 * the page was blind (SPEC §6.2 — `EventSource` resumes from `Last-Event-ID` on its own), and a
 * notifier that mistook it for news would turn a closed laptop lid into a burst of desktop
 * notifications. It is the baseline instead, announced to nobody (`attention/notify.ts`, #60).
 *
 * Nothing else here changed, and in particular the page still **does not blank on a blip**: the
 * error handler records that the connection dropped and does nothing else at all. `EventSource` is
 * already retrying, and the honest thing to show meanwhile is the last state we were given.
 */
type Stream = { event: StreamEvent | null; epoch: number };

function useStream(): Stream {
  const [stream, setStream] = useState<Stream>(NOT_YET);
  /** Set by the drop, read and cleared by the message that comes back after it. */
  const dropped = useRef(false);

  useEffect(() => {
    const source = new EventSource('/api/stream');

    source.onmessage = (message: MessageEvent<string>) => {
      const event = JSON.parse(message.data) as StreamEvent;

      // Read *outside* the updater, which React may call twice: a reconnect that consumed its own
      // flag on the first invocation would come back a plain tick on the second, and the burst
      // this exists to prevent would be back.
      const reconnected = dropped.current;
      dropped.current = false;

      setStream((previous) => ({ event, epoch: previous.epoch + (reconnected ? 1 : 0) }));
    };

    source.onerror = () => {
      dropped.current = true;
    };

    return () => source.close();
  }, []);

  return stream;
}

const NOT_YET: Stream = { event: null, epoch: 0 };

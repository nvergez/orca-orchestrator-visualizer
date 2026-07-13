import { useEffect, useState } from 'react';
import type { StreamEvent } from '../shared/types.ts';
import { App } from './App.tsx';
import type { Connection } from './connection.ts';

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
 * backoff, and no resync mode to get wrong. A dropped connection comes back with one full
 * snapshot plus exactly what was missed, down the same code path as any other tick.
 *
 * What the browser does *not* do is say any of that out loud — so this file narrates it (#57).
 * Three facts ride alongside the event, and they are all the client owes the reader:
 *
 * - **`connection`** — what the transport is doing right now. `onerror` reports a failure the
 *   `EventSource` is already retrying; the honest response is to *say so* and keep rendering
 *   the last state we were given, because blanking the page on a blip would be a worse lie
 *   than a slightly old one. An error before the first open stays `connecting` — nothing was
 *   ever connected for it to be a *re*connect of — and a later open or delivered message is
 *   each proof enough to recover.
 * - **`appliedAt`** — the wall-clock instant the last snapshot was *successfully applied*,
 *   stamped only here, only on a parsed message. It is what the top bar's data age measures
 *   from, and it is deliberately not any timestamp the server sent: the claim on screen is
 *   "this page applied a snapshot 30s ago", which only this side of the wire can know.
 *
 * Every push is a whole `StreamEvent`, so the state is a replacement and never a merge: the
 * graph is re-sent whole because it is overwritten in place (SPEC §6.3). `event.messages` is
 * the delta after the client's cursor, and **it is not accumulated here** — what little the page
 * still remembers of it lives with the thing that uses it (`conversation/pulses.ts`), so this file
 * stays the one that knows a network exists and nothing more.
 */

export function Live() {
  const { event, connection, appliedAt } = useStream();

  return <App event={event} connection={connection} appliedAt={appliedAt} />;
}

/** What the stream has delivered, and what it is doing — one state, so the two cannot skew. */
type Stream = {
  /** The latest `StreamEvent` the server has pushed, or null before the first one lands. */
  event: StreamEvent | null;
  connection: Connection;
  /** When `event` was applied, in epoch ms of *this* machine's clock; null before the first. */
  appliedAt: number | null;
};

function useStream(): Stream {
  const [stream, setStream] = useState<Stream>({ event: null, connection: 'connecting', appliedAt: null });

  useEffect(() => {
    const source = new EventSource('/api/stream');

    source.onopen = () => setStream((current) => ({ ...current, connection: 'connected' }));

    source.onmessage = (message: MessageEvent<string>) =>
      setStream({
        event: JSON.parse(message.data) as StreamEvent,
        connection: 'connected',
        appliedAt: Date.now(),
      });

    // Only a *connected* stream demotes to `reconnecting`: the last good snapshot and its
    // apply time ride along untouched, because the failure is the transport's, not the data's.
    source.onerror = () =>
      setStream((current) => (current.connection === 'connected' ? { ...current, connection: 'reconnecting' } : current));

    return () => source.close();
  }, []);

  return stream;
}

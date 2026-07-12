import { useEffect, useState } from 'react';
import type { StreamEvent } from '../shared/types.ts';
import { App } from './App.tsx';

/**
 * The transport — an `EventSource` on `/api/stream`, feeding `<App>` (#17).
 *
 * It is kept out of `<App>` on purpose, and that is the whole architecture of the client:
 * `StreamEvent` is the component's only input, so `<App>` is testable against a canned event
 * (seam 2, #12) and this file is the only one that knows a network exists.
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
 * the delta after the client's cursor, and **it is not accumulated here** — the feed's memory
 * lives with the feed (`feed/feed.ts`, #18), so this file stays the one that knows a network
 * exists and nothing more.
 */

export function Live() {
  return <App event={useStreamEvent()} />;
}

/** The latest `StreamEvent` the server has pushed, or null before the first one lands. */
function useStreamEvent(): StreamEvent | null {
  const [event, setEvent] = useState<StreamEvent | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/stream');

    source.onmessage = (message: MessageEvent<string>) => setEvent(JSON.parse(message.data) as StreamEvent);

    // No `onerror`: the failure it reports is one `EventSource` is already retrying, and the
    // honest thing to show meanwhile is the last state we were given — which is what leaving
    // it alone does. Blanking the page on a blip would be a worse lie than a slightly old one.
    return () => source.close();
  }, []);

  return event;
}

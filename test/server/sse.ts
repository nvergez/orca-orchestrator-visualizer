import type { StreamEvent } from '../../src/shared/types.ts';

/**
 * An SSE client for the tests — a real HTTP request against the real server, parsed the way
 * a browser's `EventSource` parses it.
 *
 * It exists because the two properties #17 is really about are both *about pushes over the
 * wire*: that one arrives when the database changed, and that **none** arrives when it did
 * not. Neither is observable by calling a method on the server, so the test has to be a
 * client. `EventSource` itself is not available in a node test — and would be the wrong
 * seam anyway, since it hides the `id:` field this ticket hangs its cursor on.
 */

export type Push = {
  /** The SSE event id — the message high-water mark, as a string, as the wire carries it. */
  id: string | null;
  event: StreamEvent;
};

export type SseStream = {
  contentType: string | null;
  /** The next push, or a rejection when none arrives in time. */
  next(timeoutMs?: number): Promise<Push>;
  /** Resolves only if **nothing** is pushed for `ms` — the `data_version` gate, asserted. */
  quiet(ms: number): Promise<void>;
  close(): Promise<void>;
};

/**
 * `Last-Event-ID` is sent as a plain header, which is exactly what a reconnecting
 * `EventSource` does — the resume path gets tested through the same door the browser uses.
 */
export async function openStream(origin: string, lastEventId?: number): Promise<SseStream> {
  const aborter = new AbortController();
  const response = await fetch(`${origin}/api/stream`, {
    headers: lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) },
    signal: aborter.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`GET /api/stream → ${response.status}`);
  }

  const pushes: Push[] = [];
  /** Held on an object, not in a `let`: the reader and the pump are different closures. */
  const waiter: { wake: (() => void) | null } = { wake: null };

  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffered = '';

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });

      // SSE frames are separated by a blank line; a frame is only complete when we see one.
      let end = buffered.indexOf('\n\n');
      while (end !== -1) {
        const push = parseFrame(buffered.slice(0, end));
        buffered = buffered.slice(end + 2);
        if (push) {
          pushes.push(push);
          waiter.wake?.();
        }
        end = buffered.indexOf('\n\n');
      }
    }
  })().catch(() => {
    // Aborting the request is how this stream ends, and it surfaces here as a read error.
  });

  return {
    contentType: response.headers.get('content-type'),

    next(timeoutMs = 2000) {
      const queued = pushes.shift();
      if (queued) return Promise.resolve(queued);

      return new Promise<Push>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiter.wake = null;
          reject(new Error(`no SSE push arrived within ${timeoutMs}ms`));
        }, timeoutMs);

        waiter.wake = () => {
          clearTimeout(timer);
          waiter.wake = null;
          resolve(pushes.shift()!);
        };
      });
    },

    async quiet(ms) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (pushes.length > 0) {
        throw new Error(`expected no push, but ${pushes.length} arrived: ${JSON.stringify(pushes)}`);
      }
    },

    async close() {
      aborter.abort();
      await pump;
    },
  };
}

/** `id: 12\ndata: {…}` — the only two fields this server sends. */
function parseFrame(frame: string): Push | null {
  let id: string | null = null;
  let data: string | null = null;

  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trim();
    // A frame can carry several `data:` lines; this server sends one line of JSON, and a
    // test that silently dropped the rest would be lying about what the wire holds.
    else if (line.startsWith('data:')) data = (data === null ? '' : `${data}\n`) + line.slice(5).trim();
  }

  return data === null ? null : { id, event: JSON.parse(data) as StreamEvent };
}

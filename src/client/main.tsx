import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { StreamEvent } from '../shared/types.ts';
import { App } from './App.tsx';

/**
 * The transport, kept out of `<App>` on purpose: `StreamEvent` is the component's only
 * input, which is what makes it testable against a canned event.
 *
 * One fetch of `/api/snapshot` today. #17 swaps it for an `EventSource` on `/api/stream`,
 * which pushes the same event type — so this is the only file that has to change.
 */
function Root() {
  const [event, setEvent] = useState<StreamEvent | null>(null);

  useEffect(() => {
    const aborter = new AbortController();
    fetch('/api/snapshot', { signal: aborter.signal })
      .then((response) => response.json() as Promise<StreamEvent>)
      .then(setEvent)
      .catch(() => {
        // A failed first fetch leaves "Connecting…" on screen, which is the truth. The
        // server logs the real reason, and #17 owns the reconnect story.
      });
    return () => aborter.abort();
  }, []);

  return <App event={event} />;
}

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing its #root element');

createRoot(root).render(
  <StrictMode>
    <Root />
  </StrictMode>
);

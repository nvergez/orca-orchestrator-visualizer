import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { Replay } from './Replay.tsx';

/**
 * The archived replay's mount point (#74) — `main.tsx`'s twin, and the only difference between
 * the two bundles.
 *
 * One page opens an `EventSource` and one reads a file. Which of them a browser gets is decided
 * by which *server* it is talking to (`orca-viz` vs `orca-viz --archive`), and never by a flag,
 * a route or a query string the page has to interpret — so there is no way to end up in a replay
 * that is quietly polling, or a live view that is quietly stale.
 */

const root = document.getElementById('root');
if (!root) throw new Error('replay.html is missing its #root element');

createRoot(root).render(
  <StrictMode>
    <Replay />
  </StrictMode>
);

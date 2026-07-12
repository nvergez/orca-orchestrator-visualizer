import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Live } from './Live.tsx';

/** The mount point, and nothing else. What the page *does* is `<Live>` (#17). */

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing its #root element');

createRoot(root).render(
  <StrictMode>
    <Live />
  </StrictMode>
);

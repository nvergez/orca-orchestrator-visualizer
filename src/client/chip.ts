/**
 * The pill the page announces things with — "new run started ↑" on the rail (#16), the task
 * the feed is filtered to (#18).
 *
 * One style, in one place, because it is one *token*: the same blue the rail marks the selected
 * run with and the canvas outlines the selected node with (`SELECTED_OUTLINE`). Copied into
 * each panel it would drift, and a page whose blues disagree is a page whose blues mean nothing.
 *
 * Callers spread it and add their own box model — margins are a panel's business, colour is not.
 */
export const CHIP_STYLE = {
  padding: '3px 8px',
  borderRadius: 999,
  border: '1px solid #93c5fd',
  background: '#eff6ff',
  color: '#1e3a8a',
  fontSize: 11,
  cursor: 'pointer',
} as const;

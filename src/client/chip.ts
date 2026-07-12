/**
 * The pill the page announces things with — "new run started ↑" on the rail (#16), the task id
 * the inspector copies, the dependency you can walk to (#20).
 *
 * One class string, in one place, because it is one *token*: the same blue the rail marks the
 * selected run with and the canvas outlines the selected node with (`SELECTED_RING`). Copied
 * into each panel it would drift, and a page whose blues disagree is a page whose blues mean
 * nothing.
 *
 * Callers add their own box model — margins are a panel's business, colour is not.
 */
export const CHIP_CLASS =
  'inline-flex items-center gap-1 rounded-full border border-selection/35 bg-selection-soft px-2 py-0.5 text-[11px] font-medium text-selection-ink transition-colors hover:border-selection/60 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none';

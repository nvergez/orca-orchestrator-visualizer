/**
 * **The 16 pixels the tool owns in a tab strip** (#60).
 *
 * Two states, because the queue has two: something needs intervention, or nothing does. The mark
 * is the tool — a task and the two it dispatched, which is the smallest true drawing of a DAG —
 * and the attention state is that same mark with a dot on it. Nothing about *which* cause is in
 * the queue reaches this size legibly, and pretending otherwise (five colours for five kinds, at
 * 16px, behind a favicon's own downscale) would be decoration claiming to be information: the
 * count is in the title beside it, and the ranked causes are one click away in the rail.
 *
 * **They are data URIs, not files**, and that is deliberate: this repo ships zero runtime
 * dependencies and one pre-built `dist/` (SPEC §8), the server serves the frontend from it, and a
 * favicon that lived as an asset would be a second thing to fetch, a second thing to cache and a
 * second thing to get wrong on a `404`. A string cannot fail to load — and the notification
 * (`notify.ts`) can wear the very same icon it flags the tab with, from the same constant, so the
 * desktop and the tab strip cannot come to disagree about what this tool looks like.
 *
 * The palette is fixed rather than themed: a favicon is drawn on the *browser's* chrome, not on
 * this page, so it must read on a light tab strip and a dark one alike — which the dark tile with
 * a light glyph does, and a themed pair would only manage on whichever chrome it was written for.
 */

/** The badge, and the only colour in the pair that is a claim: something is waiting for you. */
const ALERT = '#ef4444';
const TILE = '#0b0d12';
const EDGE = '#a5b4fc';
const NODE = '#e0e7ff';

/** The mark: one task, and the two it dispatched. */
const MARK = `
  <rect width="32" height="32" rx="7" fill="${TILE}"/>
  <path d="M16 12 L9 22 M16 12 L23 22" fill="none" stroke="${EDGE}" stroke-width="2.2" stroke-linecap="round"/>
  <circle cx="9" cy="22" r="3" fill="${EDGE}"/>
  <circle cx="23" cy="22" r="3" fill="${EDGE}"/>
  <circle cx="16" cy="11" r="3.4" fill="${NODE}"/>
`;

/** The same mark, wearing the one dot every unread thing on a screen has ever worn. */
const BADGE = `<circle cx="25" cy="7" r="5.6" fill="${ALERT}" stroke="${TILE}" stroke-width="2"/>`;

function icon(...parts: string[]): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${parts.join('')}</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
}

/** Nothing needs intervention. */
export const IDLE_FAVICON = icon(MARK);

/** Something does — and it is the queue, and only the queue, that says so (`tab.ts`). */
export const ATTENTION_FAVICON = icon(MARK, BADGE);

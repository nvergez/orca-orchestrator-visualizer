import { useEffect } from 'react';
import type { AttentionItem } from '../attention.ts';
import { ATTENTION_FAVICON, IDLE_FAVICON } from './favicon.ts';

/**
 * **The tab, for a reader who is looking at something else** (#60).
 *
 * A supervisor does not sit and watch this page: they start an orchestration and go and do
 * something else, which is the entire reason #51 exists. The title and the favicon are the only
 * channel this tool has to them that costs nothing, needs no permission, and cannot be denied —
 * so they are the **floor** of #60 and the desktop notification is the extra. Everything below
 * degrades to this (`notify.ts`), and this degrades to nothing.
 *
 * **It is derived from #56's queue and from nothing else** — a count of the very rows the rail is
 * showing. That is not a shortcut; it is the ticket's central constraint. A tab that counted, say,
 * blocked tasks while the queue ranked causes would be a *second urgency model*: two numbers, both
 * true, disagreeing on one screen, with no way for a reader to learn which one to believe. There
 * is one queue, and the tab is it, counted.
 *
 * So the badge leaves exactly when the evidence does — the gate is answered, the worker beats
 * again, the failure ages past the freshness window on the shared wall clock (SPEC §12.3) — and
 * needs no dismissing, because there is nothing here a reader could dismiss that would not be a
 * write back to Orca (SPEC §1.2).
 */

/**
 * The tool's name, as `index.html` types it into `<title>` before React exists. The two live in
 * two files because one of them has to be in the document before a line of JavaScript runs — the
 * same split, for the same reason, as the theme's pre-paint script.
 */
export const BASE_TITLE = 'orca-viz';

/** `(3) orca-viz` — the count first, because a tab strip crops from the right. */
export function attentionTitle(count: number): string {
  return count === 0 ? BASE_TITLE : `(${count}) ${BASE_TITLE}`;
}

/** Keeps the tab telling the truth about the queue, on every push and every wall-clock tick. */
export function useAttentionTab(items: AttentionItem[]): void {
  const count = items.length;

  useEffect(() => {
    document.title = attentionTitle(count);
    setFavicon(count === 0 ? IDLE_FAVICON : ATTENTION_FAVICON);
  }, [count]);
}

/**
 * The one `<link rel="icon">`, created on demand and then only ever re-pointed.
 *
 * `index.html` deliberately ships without one: the icon has two states and both of them are
 * derived from data that does not exist until the first snapshot lands, so a static link would be
 * a third state to keep in step with the other two. Re-writing an unchanged `href` is skipped
 * rather than merely idempotent — some browsers re-fetch on every assignment, and this runs on
 * every wall-clock tick.
 */
function setFavicon(href: string): void {
  let link = document.head.querySelector<HTMLLinkElement>('link[rel="icon"]');

  if (link === null) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.append(link);
  }

  if (link.getAttribute('href') !== href) link.setAttribute('href', href);
}

/**
 * **What the reader chose, kept between visits** — the two facts on this page that are about the
 * *reader* rather than about the database: the light they read it in (`theme-mode.ts`) and whether
 * it may reach them when they are not looking at it (`attention/notify.ts`, #60).
 *
 * They share this file for one reason: `localStorage` **throws outright** in a private-mode Safari
 * and is absent in some embedded webviews, and neither is a reason for a read-only visualizer to
 * fail to render. The guard is the whole module — the second preference to be written would
 * otherwise have re-derived it, and the third would have got it subtly wrong.
 *
 * What is *not* here is what either preference **means**: the theme validates two words and falls
 * back to the system's own choice, the notification opt-in defaults off. A store that also decided
 * that would be a store with opinions about a screen it cannot see.
 */

/** The stored string, or null — a browser that will not remember is not an error. */
export function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Remember it if we can, and carry on if we cannot. */
export function writePreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private-mode Safari throws. The choice still holds for this session, which is what matters.
  }
}

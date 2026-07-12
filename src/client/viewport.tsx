import { useSyncExternalStore } from 'react';

/**
 * Whether the shell is folded — SPEC §7.1's three-panel row re-expressed as a column below
 * Tailwind's `lg` (64rem), the width under which 18rem of rail plus 22rem of dock leave the
 * canvas nothing. This is the one place the fold is *behavior* rather than a `max-lg:` class:
 * band auto-open, re-fit on rotation, and the mobile-only chrome all key off this hook, and
 * nothing else may ask the window how wide it is.
 *
 * `matchMedia` is read through `?.` for the same reason `theme-mode.ts` reads it that way:
 * jsdom does not implement it, and its absence must mean *desktop* — so the whole existing
 * suite goes on testing the signed-off layout untouched, and a mobile assertion is something a
 * test opts into by stubbing (`vi.stubGlobal('matchMedia', …)`), never something it falls into.
 *
 * `63.9375rem` is 1023px — the widest width that is still strictly below 64rem, because the
 * legacy `max-width` syntax this query uses is inclusive where Tailwind v4's `max-lg:`
 * (`width < 64rem`) is exclusive. The two can disagree only on fractional widths strictly
 * between 1023 and 1024 CSS pixels, which is accepted.
 */
const QUERY = '(max-width: 63.9375rem)';

function subscribe(onChange: () => void): () => void {
  const mql = globalThis.matchMedia?.(QUERY);
  if (!mql) return () => {};
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return globalThis.matchMedia?.(QUERY).matches ?? false;
}

export function useIsMobile(): boolean {
  // The server snapshot is the desktop default stated a third time: no window, no fold.
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

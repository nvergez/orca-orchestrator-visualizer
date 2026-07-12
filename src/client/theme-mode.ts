import { useCallback, useEffect, useState } from 'react';

/**
 * Light or dark — the one preference this tool has, and the only state in it that is about the
 * *reader* rather than about the database.
 *
 * It lives on `<html class="dark">`, which is what every colour on the page keys off
 * (`index.css`), so flipping it is one class and never a re-render of anything that matters.
 *
 * The system's preference is the default, and a choice overrides it — for ever, in
 * `localStorage`, because a post-mortem at midnight is a thing you come back to. The read is
 * defensive on purpose: `matchMedia` is missing in jsdom and `localStorage` throws outright in a
 * private-mode Safari, and neither is a reason for a visualizer to fail to render.
 */

export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'orca-viz-theme';

export function useThemeMode(): { mode: ThemeMode; toggle: () => void } {
  const [mode, setMode] = useState<ThemeMode>(preferredMode);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((current) => {
      const next: ThemeMode = current === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // A browser that will not remember is still a browser that can render.
      }
      return next;
    });
  }, []);

  return { mode, toggle };
}

/** What the reader last chose — or, failing that, what their system already says they like. */
export function preferredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch {
    // No storage, no memory. The system preference is still an answer.
  }

  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

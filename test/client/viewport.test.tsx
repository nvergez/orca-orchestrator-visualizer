import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useIsMobile } from '../../src/client/viewport.tsx';
import { FakeMatchMedia, MOBILE_QUERY } from './fake-match-media.ts';

/**
 * `useIsMobile()` in isolation — the one hook the whole fold keys off (`viewport.tsx`,
 * `docs/design/mobile.md` §2.2).
 *
 * The first test is the important one: **with `matchMedia` absent the hook answers desktop**,
 * and that answer is the guard that protects the other 119 tests forever. jsdom implements no
 * `matchMedia`, so every existing suite renders exactly today's signed-off layout without any
 * of them knowing the fold exists — and a mobile assertion is something a test opts into by
 * stubbing, never something it falls into. If this test breaks, the whole desktop regression
 * net is quietly testing the wrong app.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A fold-answering stub, installed the way every mobile suite installs one (§2.3). */
function stubbed(matches: boolean): FakeMatchMedia {
  const media = new FakeMatchMedia();
  media.set(MOBILE_QUERY, matches);
  vi.stubGlobal('matchMedia', media.matchMedia);
  return media;
}

describe('useIsMobile', () => {
  it('answers desktop where matchMedia does not exist — the guard the other 119 tests stand behind', () => {
    // No stub at all: this is the exact environment every pre-existing client test runs in.
    expect(globalThis.matchMedia).toBeUndefined();

    const { result } = renderHook(() => useIsMobile());

    expect(result.current).toBe(false);
  });

  it('answers the stubbed query, and flips live when the viewport crosses the fold', () => {
    const media = stubbed(true);

    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);

    // A resize across 64rem — a rotation, a window drag, a fold unfolding. The change arrives
    // through the MQL listener, act-wrapped, and the hook re-reads without a remount.
    media.dispatchChange(MOBILE_QUERY, false);
    expect(result.current).toBe(false);

    media.dispatchChange(MOBILE_QUERY, true);
    expect(result.current).toBe(true);
  });

  it('removes its change listener on unmount — no subscription outlives the shell', () => {
    const media = stubbed(true);

    const { unmount } = renderHook(() => useIsMobile());
    expect(media.listenerCount(MOBILE_QUERY)).toBe(1);

    unmount();

    expect(media.listenerCount(MOBILE_QUERY)).toBe(0);
    expect(media.removals(MOBILE_QUERY)).toBe(1);
  });
});

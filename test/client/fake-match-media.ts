import { act } from '@testing-library/react';

/**
 * A stand-in for the browser's `matchMedia` — the `FakeEventSource` mold (`live.test.tsx`):
 * it records every instance it hands out, per query, so a test can assert on the subscriptions
 * the code under test actually made; and it can flip a query's answer and *dispatch* the change,
 * which is the half of the API jsdom's absence of `matchMedia` leaves untestable.
 *
 * The absence itself is load-bearing (`viewport.tsx`, `docs/design/mobile.md` §2.3): no
 * `matchMedia` means desktop, so the 119 existing tests render the signed-off layout without
 * ever knowing this file exists. A mobile assertion *opts in* —
 * `vi.stubGlobal('matchMedia', fake.matchMedia)` — and `vi.unstubAllGlobals()` in `afterEach`
 * puts the desktop default back. This is deliberately **not** a shim in `jsdom-gaps.ts`: that
 * file's own doc comment forbids it becoming a seam the suite asserts on, and this one is
 * nothing but that seam.
 *
 * One fake answers *every* query independently — the fold's width query, `(hover: hover)`,
 * `(orientation: portrait)`, `(prefers-color-scheme: dark)` — because the product code asks all
 * four and they are four different facts about a device. An unset query answers `false`, which
 * keeps a stubbed test's untouched queries (the theme's, usually) inert.
 */

/**
 * The fold's own query, verbatim from `viewport.tsx` — 63.9375rem is 1023px, the widest width
 * still strictly below Tailwind's `lg`. Repeated here rather than exported from the product
 * file, so a drift in the hook breaks these tests loudly instead of being silently mirrored.
 */
export const MOBILE_QUERY = '(max-width: 63.9375rem)';

/**
 * One `MediaQueryList`, as `matchMedia` would mint it: `matches` reads the owning fake's
 * current answer (so every instance of a query agrees, however many times the code asked), and
 * the `change` listeners are recorded so unsubscription is a fact a test can check rather than
 * hope for.
 */
export class FakeMediaQueryList {
  readonly media: string;
  /** How many `change` listeners were genuinely removed — the unsubscribe evidence. */
  removals = 0;

  private readonly owner: FakeMatchMedia;
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();

  constructor(media: string, owner: FakeMatchMedia) {
    this.media = media;
    this.owner = owner;
  }

  get matches(): boolean {
    return this.owner.matchesOf(this.media);
  }

  addEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
    if (type === 'change') this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void): void {
    if (type === 'change' && this.listeners.delete(listener)) this.removals += 1;
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** Deliver the change to everyone still subscribed. Callers wrap this in `act` (the owner does). */
  notify(): void {
    const event = { matches: this.matches, media: this.media } as MediaQueryListEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

export class FakeMatchMedia {
  /** Every list handed out, recorded per query — `FakeEventSource.opened`, keyed. */
  readonly instances = new Map<string, FakeMediaQueryList[]>();

  private readonly matchesByQuery = new Map<string, boolean>();

  /**
   * The function to install: `vi.stubGlobal('matchMedia', fake.matchMedia)`. An arrow bound as
   * a field, so the global does not need — and does not get — a `this` of its own.
   */
  readonly matchMedia = (query: string): MediaQueryList => {
    const instance = new FakeMediaQueryList(query, this);
    const recorded = this.instances.get(query);
    if (recorded) recorded.push(instance);
    else this.instances.set(query, [instance]);
    return instance as unknown as MediaQueryList;
  };

  matchesOf(query: string): boolean {
    return this.matchesByQuery.get(query) ?? false;
  }

  /** Set a query's answer without telling anybody — the state a test starts from. */
  set(query: string, matches: boolean): void {
    this.matchesByQuery.set(query, matches);
  }

  /**
   * The device changes. `act`-wrapped for the same reason `FakeEventSource.push` is: the
   * listeners land outside React's own event loop, and what they do is set React state.
   */
  dispatchChange(query: string, matches: boolean): void {
    this.matchesByQuery.set(query, matches);
    act(() => {
      for (const instance of this.instances.get(query) ?? []) instance.notify();
    });
  }

  /** How many `change` listeners are subscribed to a query right now, across all its instances. */
  listenerCount(query: string): number {
    return (this.instances.get(query) ?? []).reduce((count, instance) => count + instance.listenerCount, 0);
  }

  /** How many `change` listeners were ever removed from a query — the unsubscribe evidence. */
  removals(query: string): number {
    return (this.instances.get(query) ?? []).reduce((count, instance) => count + instance.removals, 0);
  }
}

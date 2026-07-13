import { useCallback, useEffect, useRef, useState } from 'react';
import { type AttentionItem, ATTENTION_KIND_LABEL } from '../attention.ts';
import { ATTENTION_FAVICON } from './favicon.ts';

/**
 * **One ping, for a cause you have not seen** (#60).
 *
 * The queue (#56) already answers *does anything need intervention now?* — but only to a reader
 * who is looking at the page, and the supervisor this tool is for is by definition somewhere else.
 * The tab (`tab.ts`) is the floor: it costs nothing and can never be refused. This is the extra,
 * and everything about it is a promise of restraint, because a notifier that cries wolf is turned
 * off within a day:
 *
 * 1. **Off until the reader says otherwise**, and their word is kept in `localStorage` — the same
 *    place, and for the same reason, as the theme they chose (`theme-mode.ts`).
 * 2. **Permission is asked for from their click, and nowhere else.** Browsers only allow it from a
 *    gesture, and a page that raises a permission dialog before it has shown you anything is the
 *    page you deny out of reflex. `toggle()` is the one call site in the client.
 * 3. **The queue it opens on — and the queue it reconnects to — is history.** The database is
 *    never pruned (SPEC §4.2, trap 10); thirteen runs and four days of blocking gates sit in it
 *    right now. Announcing them on load would be announcing them at *every* load, and announcing
 *    the ones that piled up behind a dropped connection would turn a laptop lid into a burst of
 *    toasts. Both are one rule: **the first snapshot of a connection is the baseline** — recorded
 *    as seen, and never announced.
 * 4. **At most one notification per stable identity.** #56 built its ids from the durable rows
 *    behind the evidence — a gate id, a run + assignee handle, a task + attempt id, a message
 *    sequence — precisely so that this can be a `Set` and not a heuristic. Repeated snapshots,
 *    re-rankings and a cause whose evidence leaves and comes back are all the same id, and the id
 *    is never announced twice.
 * 5. **Every failure degrades to the tab.** No `Notification` at all (jsdom, and older browsers),
 *    permission denied, permission revoked *while the page is open*, or a platform that has the API
 *    and throws from its constructor (Chrome on Android, which wants a service worker — out of
 *    scope for #60). None of them is an error; each of them is a tool that quietly notifies one
 *    channel less.
 *
 * There is no second urgency model here. A notification is a *cause from the queue*, delivered —
 * its kind, its explanation and its destination are #56's, verbatim, and clicking it goes exactly
 * where clicking its row in the rail goes.
 */

/** The reader's opt-in — `'on'` or `'off'`, and absent means off. */
export const NOTIFY_STORAGE_KEY = 'orca-viz-notifications';

/**
 * What the tool can actually do about notifications right now.
 *
 * `unavailable` and `blocked` are *not* the same fact and must not be shown as one: one is a
 * browser that cannot, the other is a browser that was told not to — and only the second is
 * something the reader can go and change in their own settings.
 */
export type NotifyState = 'unavailable' | 'blocked' | 'off' | 'on';

export type AttentionNotifications = {
  state: NotifyState;
  /** The user gesture, and the only place a permission is ever requested. */
  toggle: () => void;
};

export type NotifyOptions = {
  /** #56's ranked causes, exactly as the rail renders them. */
  items: AttentionItem[];
  /** False until the first snapshot lands: there is no queue to baseline before there is data. */
  connected: boolean;
  /**
   * The connection generation (`Live.tsx`). It advances when `EventSource` reconnects, and the
   * first snapshot of each generation is a baseline — which is the whole of rule 3 above.
   */
  epoch: number;
  /** Where a clicked notification goes: the shell's own `attend`, so the row and the toast agree. */
  onAttend: (item: AttentionItem) => void;
};

export function useAttentionNotifications({ items, connected, epoch, onAttend }: NotifyOptions): AttentionNotifications {
  const [enabled, setEnabled] = useState(storedOptIn);
  const [permission, setPermission] = useState<NotificationPermission | 'unavailable'>(() => readPermission(false));
  /**
   * The platform has the API and will not construct one (Chrome on Android throws `Illegal
   * constructor`). Sticky on purpose: having met that browser once, the tool stops claiming it can
   * notify on it — a control that offers what the next click cannot deliver is worse than no
   * control at all.
   */
  const [broken, setBroken] = useState(false);

  // The destination is a moving target. A notification is clicked *later* — minutes later, in
  // another tab — and `attend` closes over the snapshot the shell was rendering when it was sent.
  // The ref is what makes the click land on the task as it is *now*, not as it was.
  const attend = useRef(onAttend);
  useEffect(() => {
    attend.current = onAttend;
  }, [onAttend]);

  /** Every cause this page has ever held. Never pruned: leaving is not permission to re-announce. */
  const seen = useRef(new Set<string>());
  /** The connection whose queue has already been taken as history — null until the first snapshot. */
  const baselined = useRef<number | null>(null);

  useEffect(() => {
    if (!connected) return;

    // Read on every tick, never cached: a permission revoked in the browser's own settings while
    // this page sits open is exactly the case a startup read would miss.
    const permitted = readPermission(broken);
    setPermission(permitted);

    const fresh = items.filter((item) => !seen.current.has(item.id));
    for (const item of items) seen.current.add(item.id);

    // The baseline (rule 3) — and it is recorded whether the reader has opted in or not, so that
    // opting in mid-session announces nothing either: the queue they were looking at as they
    // clicked is not news to them.
    if (baselined.current !== epoch) {
      baselined.current = epoch;
      return;
    }

    if (!enabled || permitted !== 'granted') return;

    for (const item of fresh) {
      if (!announce(item, attend)) {
        setBroken(true);
        return;
      }
    }
  }, [items, epoch, connected, enabled, broken]);

  const toggle = useCallback((): void => {
    void (async () => {
      const api = globalThis.Notification;
      if (broken || api === undefined) return;

      if (enabled && api.permission === 'granted') {
        remember(false);
        setEnabled(false);
        return;
      }

      // **The gesture.** This call — and no other in the client — may raise the browser's dialog,
      // and it may only do so from inside the click that led here.
      if (api.permission === 'default') {
        try {
          await api.requestPermission();
        } catch {
          // Safari's legacy callback form resolves nothing at all. Whatever happened, the answer
          // is on `Notification.permission` below, which is the only authority worth reading.
        }
      }

      const granted = api.permission === 'granted';
      setPermission(readPermission(false));
      // A wish that cannot come true is not recorded as one: the control has to say what will
      // actually happen, and after a denial what happens is nothing.
      remember(granted);
      setEnabled(granted);
    })();
  }, [broken, enabled]);

  return { state: stateOf(enabled, permission), toggle };
}

function stateOf(enabled: boolean, permission: NotificationPermission | 'unavailable'): NotifyState {
  if (permission === 'unavailable') return 'unavailable';
  if (permission === 'denied') return 'blocked';
  return enabled && permission === 'granted' ? 'on' : 'off';
}

/**
 * The cause, on the desktop: its kind as the title, its own words as the body, and the
 * orchestration it belongs to — because a cross-run queue that never says *whose* cause this is
 * sends every click in blind (#56).
 *
 * `tag` is the item's stable id, so the OS collapses a repeat instead of stacking one, and the icon
 * is the same badged mark the tab is wearing at that moment (`favicon.ts`).
 *
 * Returns false — and only false — when the platform refuses to construct a notification at all.
 */
function announce(item: AttentionItem, attend: { current: (item: AttentionItem) => void }): boolean {
  const api = globalThis.Notification;
  if (api === undefined) return false;

  try {
    const notification = new api(sentence(ATTENTION_KIND_LABEL[item.kind]), {
      body: item.runLabel === null ? `${item.title} · ${item.explanation}` : `${item.title} · ${item.explanation} · ${item.runLabel}`,
      tag: item.id,
      icon: ATTENTION_FAVICON,
    });

    notification.onclick = () => {
      try {
        // The reader is, by definition, somewhere else. Where the platform allows it, come forward.
        window.focus();
      } catch {
        // A platform that will not raise its window still has a page that can navigate.
      }
      notification.close();
      attend.current(item);
    };

    return true;
  } catch {
    return false;
  }
}

/** "blocking decision gate" → "Blocking decision gate". The vocabulary is CONTEXT.md's, not ours. */
function sentence(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function readPermission(broken: boolean): NotificationPermission | 'unavailable' {
  if (broken || globalThis.Notification === undefined) return 'unavailable';
  return globalThis.Notification.permission;
}

function storedOptIn(): boolean {
  try {
    return localStorage.getItem(NOTIFY_STORAGE_KEY) === 'on';
  } catch {
    // A browser that will not remember is still a browser that can notify — for this session.
    return false;
  }
}

function remember(enabled: boolean): void {
  try {
    localStorage.setItem(NOTIFY_STORAGE_KEY, enabled ? 'on' : 'off');
  } catch {
    // Private-mode Safari throws outright. It is not a reason to fail to notify.
  }
}

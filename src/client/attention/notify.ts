import { useCallback, useEffect, useRef, useState } from 'react';
import { type AttentionItem, ATTENTION_KIND_LABEL } from '../attention.ts';
import { readPreference, writePreference } from '../preference.ts';

/**
 * **One notification, for a cause you have not seen** (#60).
 *
 * The queue (#56) already answers *does anything need intervention now?* — but only to a reader
 * who is looking at the page, and the supervisor this tool is for is by definition somewhere else.
 * The tab (`tab.ts`) is the floor: it costs nothing and can never be refused. This is the extra,
 * and everything about it is a promise of restraint, because a notifier that cries wolf is turned
 * off within a day:
 *
 * 1. **Off until the reader says otherwise**, and their word is kept where the theme they chose is
 *    kept (`preference.ts`), for the same reason: a choice about the reader outlives the tab.
 * 2. **Permission is asked for from their click, and nowhere else.** Browsers only allow it from a
 *    gesture, and a page that raises a permission dialog before it has shown you anything is the
 *    page you deny out of reflex. `toggle()` is the one call site in the client.
 * 3. **The queue it opens on — and the queue it reconnects to — is history.** The database is
 *    never pruned (SPEC §4.2, trap 10); thirteen runs and four days of blocking gates sit in it
 *    right now. Announcing them on load would be announcing them at *every* load, and announcing
 *    the ones that piled up behind a dropped connection would turn a closed laptop lid into an
 *    alarm. Both are one rule: **the first snapshot of a connection is the baseline** — recorded
 *    as seen, and never announced (`docs/adr/0002-…`).
 * 4. **At most one notification per stable identity, and at most one per snapshot.** #56 built its
 *    ids from the durable rows behind the evidence — a gate id, a run + assignee handle, a task +
 *    attempt id, a message sequence — precisely so that this can be a `Set` and not a heuristic.
 *    Repeated snapshots, re-rankings and a cause whose evidence leaves and comes back are all the
 *    same id, and the id is never announced twice. Several causes arriving *together* — which is
 *    not hypothetical, since a coordinator's five workers can cross the ten-minute silence
 *    threshold on one wall-clock tick — are one notification that says so, never five.
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
 * What the browser will let us do, which is a different question from what the reader asked for.
 *
 * `unavailable` is not a fourth permission: it is *this tool's* word for a browser that has no
 * `Notification` to grant (jsdom, older browsers) or has one it refuses to construct. It is kept
 * apart from `denied` all the way to the control, because only `denied` is something the reader
 * can go and change.
 */
export type NotifyPermission = NotificationPermission | 'unavailable';

/** What the tool can actually do about notifications right now — the control renders exactly this. */
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
  /** Where a clicked notification goes: the shell's own `attend`, so the row and it agree. */
  onAttend: (item: AttentionItem) => void;
};

export function useAttentionNotifications({ items, connected, epoch, onAttend }: NotifyOptions): AttentionNotifications {
  const [enabled, setEnabled] = useState(storedOptIn);
  const [permission, setPermission] = useState<NotifyPermission>(readPermission);
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
    const permitted = broken ? 'unavailable' : readPermission();
    setPermission(permitted);

    // In the queue's own rank order, because that is what makes `fresh[0]` the most urgent thing
    // that just arrived — the one a summary names, and the one its click goes to.
    const fresh = items.filter((item) => !seen.current.has(item.id));
    for (const item of items) seen.current.add(item.id);

    // The baseline (rule 3) — and it is recorded whether the reader has opted in or not, so that
    // opting in mid-session announces nothing either: the queue they were looking at as they
    // clicked is not news to them.
    if (baselined.current !== epoch) {
      baselined.current = epoch;
      return;
    }

    if (!enabled || permitted !== 'granted' || fresh.length === 0) return;

    const announced = announce(notificationOf(fresh), () => attend.current(fresh[0]!));
    if (!announced) setBroken(true);
  }, [items, epoch, connected, enabled, broken]);

  const toggle = useCallback((): void => {
    void (async () => {
      const api = globalThis.Notification;
      // Nothing to toggle, and nothing to ask: the control is telling the reader so, and a click
      // that quietly rewrote their stored wish would be a control that lies about being inert.
      if (broken || api === undefined || api.permission === 'denied') return;

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
      setPermission(readPermission());
      // A wish that cannot come true is not recorded as one: the control has to say what will
      // actually happen, and after a denial what happens is nothing.
      remember(granted);
      setEnabled(granted);
    })();
  }, [broken, enabled]);

  return { state: stateOf(enabled, permission), toggle };
}

function stateOf(enabled: boolean, permission: NotifyPermission): NotifyState {
  if (permission === 'unavailable') return 'unavailable';
  if (permission === 'denied') return 'blocked';
  return enabled && permission === 'granted' ? 'on' : 'off';
}

/** What a notification says. Separated from the sending so the words can be read in a test. */
export type AttentionNotification = { title: string; body: string; tag: string };

/**
 * The causes that just arrived, in the reader's language.
 *
 * **One cause** is named outright: its kind as the title — CONTEXT.md's vocabulary, through
 * `ATTENTION_KIND_LABEL`, so the notification and the queue's own row cannot come to call it two
 * different things — and its own words, with the orchestration it belongs to, as the body. A
 * cross-run queue that never said *whose* cause this is would send every click in blind (#56).
 *
 * **Several** are one notification that counts them and names the most urgent, because a burst of
 * five is how a notifier gets turned off, and because five things needing attention is *one* piece
 * of news to a supervisor: something has gone wrong over there. The queue itself, one click away,
 * is where the other four are — ranked, which a stack of five notifications would not be.
 *
 * The `tag` is the stable id of the cause the notification is *about*, so a platform that collapses
 * on tags collapses a repeat rather than stacking one.
 */
export function notificationOf(fresh: AttentionItem[]): AttentionNotification {
  const first = fresh[0]!;
  const where = first.runLabel === null ? '' : ` · ${first.runLabel}`;

  if (fresh.length === 1) {
    return {
      title: sentence(ATTENTION_KIND_LABEL[first.kind]),
      body: `${first.title} · ${first.explanation}${where}`,
      tag: first.id,
    };
  }

  return {
    title: `${fresh.length} things need attention`,
    body: `${first.title} · ${first.explanation}${where} — and ${fresh.length - 1} more`,
    tag: first.id,
  };
}

/**
 * Sends it, and wires its click to the destination its cause already has.
 *
 * **No `icon`.** The tab's badged mark (`favicon.ts`) is an SVG data URI, and Chrome and Firefox
 * decode a notification icon as a raster image — an SVG renders as nothing at all. A silently
 * ignored option is a claim this file would be making and the desktop would not be keeping, so it
 * is not made: the browser shows its own mark for the origin, which is honest and is already right.
 *
 * Returns false — and only false — when the platform refuses to construct a notification at all.
 */
function announce({ title, body, tag }: AttentionNotification, onClick: () => void): boolean {
  const api = globalThis.Notification;
  if (api === undefined) return false;

  try {
    const notification = new api(title, { body, tag });

    notification.onclick = () => {
      try {
        // The reader is, by definition, somewhere else. Where the platform allows it, come forward.
        window.focus();
      } catch {
        // A platform that will not raise its window still has a page that can navigate.
      }
      notification.close();
      onClick();
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

function readPermission(): NotifyPermission {
  return globalThis.Notification?.permission ?? 'unavailable';
}

function storedOptIn(): boolean {
  return readPreference(NOTIFY_STORAGE_KEY) === 'on';
}

function remember(enabled: boolean): void {
  writePreference(NOTIFY_STORAGE_KEY, enabled ? 'on' : 'off');
}

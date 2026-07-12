import type { FeedMessage } from '../../shared/types.ts';

/**
 * What a panel of messages *shows* — the scope, and the one ruling that made this module
 * necessary in the first place.
 *
 * **Heartbeats are 65% of all traffic** (302 of 466 in the live database) and all of them
 * carry a `taskId`. Rendered straight, the feed is a heartbeat ticker with the real events
 * lost inside it. Their value is *liveness*, not event-ness — they already became the node's
 * "last seen 12s ago" badge (SPEC §4.6) — so they are **absent from the feed by default** and
 * one toggle away. What is left is `worker_done` + `decision_gate` + `escalation` + `status`:
 * 164 rows over four days, which is actually readable (SPEC §7.7).
 *
 * The filtering is the *client's*, not the server's, and deliberately: the server sends every
 * message once, after a cursor, and never again. A payload that hid heartbeats would put them
 * behind a cursor that had already passed them, so the "show heartbeats" toggle would have to
 * re-read the feed from the top — which is exactly the resync path #17 was built to not have.
 *
 * Pure, and free of React, because the evidence for the heartbeat ruling is a *database*: the
 * suite asserts this function against the 65%-heartbeat corpus over a real snapshot
 * (`test/server/messages.test.ts`), not against a hand-written array that could agree with it
 * by construction.
 */

export type FeedFilter = {
  /**
   * The selected run, or null for every message there is.
   *
   * Null is what the **inspector** passes (#20): its messages are one task's, fetched from
   * `/api/task/:id` and already the right set — what it wants from here is the heartbeat rule,
   * which is this module's and not a second copy of it. And it is what the feed's "All" scope
   * passes, for a different reason: the global `sequence` timeline is the only true total order
   * the schema has.
   */
  runId: string | null;
  /** The one thing the user can ask back in. Off by default. */
  showHeartbeats: boolean;
};

export type FeedSelection = {
  /** The rows to render, in `sequence` order — oldest first. */
  shown: FeedMessage[];
  /**
   * How many rows in scope the heartbeat filter is holding back.
   *
   * Counted rather than implied, and returned from the same pass that decides `shown`: a user
   * looking at 164 rows in a database of 466 messages is owed the reason, or the tool looks
   * like it lost three hundred of them.
   */
  hidden: number;
};

/** What a panel renders: the rows, what the default is holding back, and the clock to age them by. */
export type FeedView = FeedSelection & {
  /** The instant every age in the panel is measured from — one clock, so a list ages in step. */
  now: number;
};

/**
 * The selection, and the clock — the pair both panels of messages need, taken together so that
 * neither has to reach for `Date.now()` in its own render (and so the two cannot disagree about
 * what "now" is).
 *
 * The impurity stops here: `selectFeed` below is pure, which is what lets the suite assert it
 * against a real snapshot of the 65%-heartbeat corpus (`test/server/messages.test.ts`).
 */
export function viewOf(messages: readonly FeedMessage[], filter: FeedFilter): FeedView {
  return { ...selectFeed(messages, filter), now: Date.now() };
}

export function selectFeed(messages: readonly FeedMessage[], filter: FeedFilter): FeedSelection {
  const shown: FeedMessage[] = [];
  let hidden = 0;

  for (const message of messages) {
    if (!inScope(message, filter)) continue;

    if (!filter.showHeartbeats && message.type === 'heartbeat') {
      hidden++;
      continue;
    }

    shown.push(message);
  }

  return { shown, hidden };
}

function inScope(message: FeedMessage, { runId }: FeedFilter): boolean {
  // Every message it was handed — the feed's "All" scope, and the inspector, which has already
  // narrowed to one task's story and is here for the heartbeat rule alone.
  if (runId === null) return true;

  // A message the server could not place (`runId: null`) appears in "All" and nowhere else —
  // never guessed into the run you happen to be reading (SPEC §4.4).
  return message.runId === runId;
}

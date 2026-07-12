import type { FeedMessage } from '../../shared/types.ts';

/**
 * What the feed *shows* — the three filters, and the one ruling that made this ticket
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
  /** The selected run, or null for the "All" scope — the global `sequence` timeline. */
  runId: string | null;
  /** A selected task narrows the feed to that task's story, across the whole database. */
  taskId: string | null;
  /** The one thing the user can ask back in. Off by default. */
  showHeartbeats: boolean;
};

export function visibleMessages(messages: readonly FeedMessage[], filter: FeedFilter): FeedMessage[] {
  return messages.filter((message) => matches(message, filter));
}

function matches(message: FeedMessage, { runId, taskId, showHeartbeats }: FeedFilter): boolean {
  if (!showHeartbeats && message.type === 'heartbeat') return false;

  // A selected task is the *narrower* filter, and it wins over the scope: "read this task's
  // story end to end" (#12, story 34) is a question about the task, not about the run the
  // canvas happens to be showing.
  if (taskId !== null) return message.taskId === taskId;

  // "All" — every message in the database, in one timeline. The global `sequence` order is
  // the only true total order the schema has, and it costs nothing to expose (SPEC §7.3).
  if (runId === null) return true;

  // A message the server could not place (`runId: null`) appears in "All" and nowhere else —
  // never guessed into the run you happen to be reading (SPEC §4.4).
  return message.runId === runId;
}

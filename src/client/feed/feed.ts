import { useEffect, useRef, useState } from 'react';
import type { FeedMessage, StreamEvent } from '../../shared/types.ts';
import { type Pulse, PULSE_MS, pulseOf } from './theme.ts';

/**
 * The feed's memory, and the canvas's flash.
 *
 * **`StreamEvent.messages` is a delta, not the feed.** The graph is re-sent whole on every
 * push because it is overwritten in place; the messages are append-only, so the server sends
 * each one exactly once, after the client's cursor (SPEC §6.3). That is what makes the feed
 * cheap and it is what makes this hook necessary: nobody else remembers what has already
 * arrived. #17 left this deliberately undone — a feed that remembers is this ticket's.
 *
 * Keyed by `sequence`, which is AUTOINCREMENT and unique, so a message that arrives twice —
 * a reconnect resuming one message early, say — lands in the same slot rather than twice in
 * the list.
 */

export type Feed = {
  /** Everything seen so far, oldest first. The panel decides which way to render it. */
  messages: FeedMessage[];
  /**
   * What arrived in the *last* push, and nothing on the first one.
   *
   * The distinction is the pulse: a message that just landed is news and flashes its node; the
   * 466 messages that come down on first connect are the *page*, and flashing them would strobe
   * the whole canvas at once for the sake of announcing four days of history.
   */
  arrived: FeedMessage[];
};

const NOTHING: FeedMessage[] = [];

export function useFeed(event: StreamEvent | null): Feed {
  const [feed, setFeed] = useState<Feed>({ messages: NOTHING, arrived: NOTHING });
  const seen = useRef(new Map<number, FeedMessage>());
  const connected = useRef(false);

  useEffect(() => {
    if (event === null) return;

    const first = !connected.current;
    connected.current = true;

    // An idle-but-changed tick — a `ready → dispatched` flip — carries no messages at all.
    // Rebuilding the list for it would hand the panel a new array to re-render for nothing.
    if (event.messages.length === 0) return;

    for (const message of event.messages) seen.current.set(message.sequence, message);

    setFeed({
      messages: [...seen.current.values()].sort((a, b) => a.sequence - b.sequence),
      arrived: first ? NOTHING : event.messages,
    });
  }, [event]);

  return feed;
}

/**
 * Which nodes are flashing, and in which colour (SPEC §7.6).
 *
 * A message referencing a task pulses **that node** — not an edge. Messages are a star between
 * *handles*; dep edges connect *tasks*, and a `worker_done` travelling worker-terminal →
 * coordinator-terminal does not traverse the edge from task A to task B. Animating one along
 * that edge would draw a flow that does not exist, which is why the map's "animate messages
 * along the DAG" item was rejected on evidence rather than deferred. 83% of messages carry a
 * `payload.taskId`; **none** carries an edge.
 *
 * Heartbeats never pulse, and neither does anything else without a colour (`theme.ts`).
 */
export function usePulses(arrived: FeedMessage[]): ReadonlyMap<string, Pulse> {
  const [pulses, setPulses] = useState<ReadonlyMap<string, Pulse>>(NO_PULSES);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Cleared on unmount only — never between batches. A cleanup that cancelled the *previous*
  // batch's timer would leave that batch's nodes lit for ever the moment two pushes landed
  // inside one pulse.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  useEffect(() => {
    const flashing = arrived.flatMap((message) => {
      const pulse = message.taskId === null ? null : pulseOf(message.type);
      return pulse === null ? [] : [[message.taskId!, pulse] as const];
    });

    if (flashing.length === 0) return;

    // Later in the push wins: two messages about one task in one tick can only flash one
    // colour, and the last thing that happened is the one worth seeing.
    setPulses((current) => new Map([...current, ...flashing]));

    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setPulses((current) => {
        const next = new Map(current);
        for (const [taskId, pulse] of flashing) {
          // Only if it is still *this* pulse: a newer message may have re-lit the node in
          // another colour since, and that one owns the node until its own timer fires.
          if (next.get(taskId)?.type === pulse.type) next.delete(taskId);
        }
        return next;
      });
    }, PULSE_MS);

    timers.current.add(timer);
  }, [arrived]);

  return pulses;
}

const NO_PULSES: ReadonlyMap<string, Pulse> = new Map();

import { useEffect, useRef, useState } from 'react';
import type { FeedMessage, StreamEvent } from '../../shared/types.ts';
import { type Pulse, PULSE_MS, pulseOf } from './theme.ts';

/**
 * **What just happened** — the one question a snapshot cannot answer.
 *
 * The conversation itself is `snapshot.turns`: re-derived whole on every push, and the client does
 * nothing to it but choose a scope. So nothing on this page has to *remember* messages any more…
 * except for this. A pulse is the difference between a row that has always been there and a row
 * that landed a second ago, and a snapshot — which is a photograph — has no way to tell you which.
 *
 * `StreamEvent.messages` still does: it is the append-only delta after the client's cursor (SPEC
 * §6.3), so anything in it is, by construction, news. That is the whole of what it is for now, and
 * it is worth its place on the wire for it: this is the only thing on screen that says *look here,
 * this is happening right now*.
 */

const NOTHING: FeedMessage[] = [];

/**
 * The messages that arrived in the **last** push, and none on the first.
 *
 * The distinction is the pulse: a message that just landed is news and flashes its node; the 466
 * that come down on first connect are the *page*, and flashing them would strobe the whole canvas
 * at once for the sake of announcing four days of history.
 */
export function useArrivals(event: StreamEvent | null): FeedMessage[] {
  const [arrived, setArrived] = useState<FeedMessage[]>(NOTHING);
  const connected = useRef(false);

  useEffect(() => {
    if (event === null) return;

    const first = !connected.current;
    connected.current = true;

    // An idle-but-changed tick — a `ready → dispatched` flip — carries no messages at all. Handing
    // the canvas a new empty array for it would re-run every pulse effect for nothing.
    if (event.messages.length === 0) return;

    setArrived(first ? NOTHING : event.messages);
  }, [event]);

  return arrived;
}

/**
 * Which nodes are flashing, and in which colour (SPEC §7.6).
 *
 * A message referencing a task pulses **that node** — not an edge. Messages are a star between
 * *handles*; dep edges connect *tasks*, and a `worker_done` travelling worker-terminal →
 * coordinator-terminal does not traverse the edge from task A to task B. Animating one along that
 * edge would draw a flow that does not exist, which is why the map's "animate messages along the
 * DAG" item was rejected on evidence rather than deferred. 83% of messages carry a
 * `payload.taskId`; **none** carries an edge.
 *
 * Heartbeats never pulse, and neither does anything else without a colour (`theme.ts`).
 */
export function usePulses(arrived: FeedMessage[]): ReadonlyMap<string, Pulse> {
  const [pulses, setPulses] = useState<ReadonlyMap<string, Pulse>>(NO_PULSES);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  // Cleared on unmount only — never between batches. A cleanup that cancelled the *previous*
  // batch's timer would leave that batch's nodes lit for ever the moment two pushes landed inside
  // one pulse.
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

    // Later in the push wins: two messages about one task in one tick can only flash one colour,
    // and the last thing that happened is the one worth seeing.
    setPulses((current) => new Map([...current, ...flashing]));

    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setPulses((current) => {
        const next = new Map(current);
        for (const [taskId, pulse] of flashing) {
          // Only if it is still *this* pulse: a newer message may have re-lit the node in another
          // colour since, and that one owns the node until its own timer fires.
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

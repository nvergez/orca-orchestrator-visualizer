import { useEffect, useSyncExternalStore } from 'react';

/**
 * How often the shared wall clock advances on its own, push or no push (SPEC §12.3).
 *
 * 30 seconds is fast enough that `active → silent` lands within moments of the ten-minute
 * boundary, and far too slow to matter next to a 5-second poll cadence. It must exist at all
 * because a quiet database is precisely the case run health has to move in: the `data_version`
 * gate pushes nothing, and a clock read only on pushes would leave "active" on screen forever.
 */
export const WALL_CLOCK_TICK_MS = 30_000;

let wallClockNow = Date.now();
let wallClockInterval: ReturnType<typeof setInterval> | null = null;
const wallClockListeners = new Set<() => void>();

function readWallClock(): number {
  return wallClockNow;
}

function tickWallClock(): void {
  wallClockNow = Date.now();
  for (const listener of wallClockListeners) listener();
}

function subscribeWallClock(listener: () => void): () => void {
  wallClockListeners.add(listener);

  if (wallClockInterval === null) {
    tickWallClock();
    wallClockInterval = setInterval(tickWallClock, WALL_CLOCK_TICK_MS);
  }

  return () => {
    wallClockListeners.delete(listener);
    if (wallClockListeners.size === 0 && wallClockInterval !== null) {
      clearInterval(wallClockInterval);
      wallClockInterval = null;
    }
  };
}

/**
 * **The instant a panel measures its ages from** — one clock, so a list ages in step.
 *
 * The panels that show "how long ago" — the rail's health dots and "seen 12s ago" badges, the
 * conversation's turns, the inspector's attempts — would otherwise each reach for `Date.now()`
 * in their own render: a value that changes *every time React happens to re-render*, so two rows
 * measured a frame apart would be measured against two different "now"s.
 *
 * Every mounted consumer subscribes to this one module clock instead. It re-reads the wall
 * clock at two well-defined moments: **on every push** — the dependency is the data the panel
 * is showing, and a new one means the stream just delivered (`Live.tsx`) — and **every 30
 * seconds while any consumer is mounted**, because run health has to cross the ten-minute
 * boundary on wall-clock time alone, without any SSE event (SPEC §12.3).
 */
export function useNow(pushed: unknown): number {
  const now = useSyncExternalStore(subscribeWallClock, readWallClock, readWallClock);

  useEffect(() => {
    tickWallClock();
  }, [pushed]);

  return now;
}

/**
 * "12s", "3m", "2h", "4d" — how long ago, coarsely.
 *
 * Coarse on purpose. Both the things that use it are answering *is this recent?* — the node's
 * "last seen 12s ago" badge, and the age of a turn in the conversation — and neither is answering
 * *exactly when?*, which is what the absolute timestamp in the row's tooltip is for.
 *
 * Shared between the canvas and the conversation, because two of these would eventually round
 * differently and the same message would then be two different ages on one screen.
 */
export function relativeTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** An instant on screen: what to show, what to put in its tooltip, and whether it read at all. */
export type Age = {
  /** "3m ago" — or the raw column value, when that is all there is to say. */
  label: string;
  /** The exact instant, in the reader's own timezone, for when "3m" is not enough. */
  title: string;
  /** False ⇒ the string is not a timestamp, and nothing here has treated it as one. */
  readable: boolean;
};

/**
 * How long ago an instant was — and what to do when it is not one.
 *
 * A timestamp this tool could not normalize reaches the client **verbatim** rather than being
 * dropped (`server/time.ts`, SPEC §5), so every panel that renders an instant has to decide what
 * to do with a string that is not one. There is one right answer — show it as it was written,
 * never as "NaN ago" — and it is made here, once, rather than in each panel that would eventually
 * make it differently: a turn's age, and the inspector's dispatch timestamps.
 */
export function ageOf(at: string, now: number): Age {
  const instant = Date.parse(at);

  if (Number.isNaN(instant)) return { label: at, title: at, readable: false };

  return { label: `${relativeTime(now - instant)} ago`, title: new Date(instant).toLocaleString(), readable: true };
}

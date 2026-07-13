import { useEffect, useState } from 'react';

/**
 * **The instant a panel measures its ages from** — one clock, so a list ages in step.
 *
 * Three panels show "how long ago" against a list of things, and each of them would otherwise reach
 * for `Date.now()` in its own render: the rail's "seen 12s ago" badges, the conversation's turns,
 * and the inspector's attempts. Two problems with that, and only one of them is the linter's.
 *
 * The real one is that `Date.now()` in a render body is a value that changes *every time React
 * happens to re-render* — a hover, a state flip in a sibling — so two rows measured a frame apart
 * would be measured against two different "now"s. This reads the clock **once per push**: the
 * dependency is the data the panel is showing, and a new one means the stream just delivered
 * (`Live.tsx`), which is exactly when an age is worth re-reading.
 */
export function useNow(pushed: unknown): number {
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
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
/**
 * **The instant a wire string names — or null when it names none.**
 *
 * The server's own rule (`server/time.ts`), client-side, and in one place for the reason this module
 * exists: `isoInstant` passes an unreadable column through *verbatim* rather than dropping the row,
 * so every instant on this wire is ISO **or** whatever nonsense the column actually held. Null is
 * how that nonsense stays honest — an unknown instant is not the epoch, and quietly reading it as
 * `0` is what mints a 1970 ghost at the far left of every timeline.
 */
export function instantOf(iso: string | null | undefined): number | null {
  if (!iso) return null;

  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : at;
}

/**
 * The exact instant, in the reader's own timezone — the wire is UTC and nobody reads a post-mortem
 * in UTC. Unreadable in, unreadable out: a tooltip that showed "Invalid Date" would be worse than
 * one that showed the string the database actually holds.
 */
export function localInstant(iso: string): string {
  const at = instantOf(iso);
  return at === null ? iso : new Date(at).toLocaleString();
}

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

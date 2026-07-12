/**
 * "12s", "3m", "2h", "4d" — how long ago, coarsely.
 *
 * Coarse on purpose. Both the things that use it are answering *is this recent?* — the node's
 * "last seen 12s ago" badge, and the age of a row in the feed — and neither is answering
 * *exactly when?*, which is what the absolute timestamp in the row's tooltip is for.
 *
 * Shared between the canvas and the feed, because two of these would eventually round
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
 * make it differently: the feed row's age, and the inspector's dispatch timestamps.
 */
export function ageOf(at: string, now: number): Age {
  const instant = Date.parse(at);

  if (Number.isNaN(instant)) return { label: at, title: at, readable: false };

  return { label: `${relativeTime(now - instant)} ago`, title: new Date(instant).toLocaleString(), readable: true };
}

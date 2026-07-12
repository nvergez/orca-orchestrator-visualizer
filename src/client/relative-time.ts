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

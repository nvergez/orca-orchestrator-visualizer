/**
 * What the `EventSource` is doing right now (#57).
 *
 * Three states, and the third is not the first: `connecting` has never had the stream,
 * `reconnecting` had it and lost it — which is why only the latter is worth alarming over,
 * and why an error before the first open stays `connecting` (`useStream`, `Live.tsx`).
 */
export type Connection = 'connecting' | 'connected' | 'reconnecting';

/**
 * The words the top bar says for each transport state (#57).
 *
 * This is the `EventSource`'s story, and nobody else's. The page already tells two other
 * stories that are easy to mistake for it, and the wording exists to keep all three apart:
 * `meta.liveness` answers *is anything still writing to the database* (the green pill), and
 * the data age answers *how old is what I am looking at* (`DataAge`, `App.tsx`). A stream can
 * be reconnecting over a database Orca is happily writing to, and a stream can be perfectly
 * connected while the age grows — a quiet orchestration, not a failure. Each sentence names
 * the stream so it cannot be read as a claim about Orca.
 */
export const CONNECTION_WORDING: Record<Connection, string> = {
  connecting: 'Stream connecting…',
  connected: 'Stream connected',
  reconnecting: 'Stream reconnecting…',
};

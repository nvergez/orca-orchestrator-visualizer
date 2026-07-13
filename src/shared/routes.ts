/**
 * **The screens this application has** — one list, shared, because both halves of the wire have to
 * agree about it and they fail in opposite directions if they do not.
 *
 * The server has to know which paths are *screens* rather than files, so it can answer them with
 * the one `index.html` the bundle ships (`server/server.ts`) — and still 404 everything else,
 * because a typo that silently renders the wrong screen is worse than one that says so.
 *
 * The client has to know which screen the path it woke up at names (`client/route.ts`).
 *
 * A path the server serves and the client does not recognize is a blank page; a path the client
 * recognizes and the server does not is a 404 the user reaches by typing the URL they were given.
 * So the list lives here, where `shared/` already keeps every other fact the two ends must not
 * disagree about.
 */

/** The DAG-free supervision wall (#62). A route, and never a mode: no flag, no second process. */
export const KIOSK_PATH = '/kiosk';

/** Paths served the application document. Everything else is a file, or a 404. */
export const APP_ROUTES: readonly string[] = ['/', KIOSK_PATH];

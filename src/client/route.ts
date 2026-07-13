/**
 * Which screen the URL names — the whole of this application's routing (#62).
 *
 * Two screens, one bundle, one server: `/` is the shell a supervisor works in, `/kiosk` is the
 * same data with nothing on it you could click by accident. The server serves the identical
 * document at both (`APP_ROUTES`, `server/server.ts`), so nothing about the route reaches the
 * back end — a kiosk is not a mode, and there is no flag, no second process and no second build
 * that turns one on.
 *
 * **There is no router, and no history.** A router is for an application whose screens link to
 * each other, and these two do not: the kiosk deliberately has nothing to navigate *from* — it
 * is a wall display — and the shell has nowhere to go *to* that the reader did not type. So the
 * path is read once, where the page mounts (`Live.tsx`), and a `popstate` listener would be
 * listening for an event this application has no way of producing.
 *
 * A trailing slash is the same screen; anything else at all is the shell. Nothing here can throw
 * and nothing here is async: it is a string, in a corner of the URL, and the wrong answer would
 * cost a reader the screen they asked for.
 */

export type Route = 'main' | 'kiosk';

/** The kiosk's path, in one place — the client's half of the server's `APP_ROUTES`. */
export const KIOSK_PATH = '/kiosk';

export function routeOf(pathname: string): Route {
  return pathname === KIOSK_PATH || pathname === `${KIOSK_PATH}/` ? 'kiosk' : 'main';
}

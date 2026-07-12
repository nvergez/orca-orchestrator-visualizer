import { spawn } from 'node:child_process';

/**
 * Auto-opening the browser, and knowing when not to.
 *
 * For a one-shot `npx` tool the user's intent in typing the command *is* "show me the
 * thing" (SPEC §6.4), so the browser opens by default. But it self-suppresses wherever it
 * could not or should not work — a headless `orca serve` box then just prints the URL
 * instead of failing at a browser that is not there.
 */

export type BrowserContext = {
  /** `--no-open`. */
  open: boolean;
  /** Is stdout a terminal? A pipe or a CI log did not ask for a browser window. */
  isTTY: boolean;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
};

export function shouldOpenBrowser({ open, isTTY, env, platform }: BrowserContext): boolean {
  if (!open || !isTTY) return false;

  // Someone is watching over SSH: the browser they want is on *their* machine, and it is
  // the printed URL that gets them there.
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return false;
  if (env.CI) return false;

  // On Linux a missing display is the definition of headless. macOS and Windows always
  // have a window server when there is a terminal at all.
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;

  return true;
}

/**
 * Best-effort: the URL has already been printed, so a browser that will not open costs the
 * user nothing. Failing the boot over it would be absurd.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): void {
  const [command, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? // `start` is a cmd builtin; its first quoted argument is the window title, which
          // is why the empty string has to be there before the URL.
          ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];

  try {
    const child = spawn(command as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {}); // No browser, no opener, no problem — the URL is on screen.
    child.unref();
  } catch {
    // Same.
  }
}

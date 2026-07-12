/**
 * The Node floor, checked loudly.
 *
 * `node:sqlite` — the driver decision that the entire `npx` story rests on, because it
 * means zero native dependencies and nothing to compile on first run — landed in Node
 * **22.5**. Below that, the failure the user actually sees is `Cannot find module
 * 'node:sqlite'`, which tells them nothing. npm's own `engines` warning is easy to miss and
 * does not stop the run.
 *
 * So this module must be importable by a Node that *cannot run the rest of the tool*: it
 * touches nothing but `process.versions`. The bin shim calls it before it imports anything
 * else (see `bin/orca-viz.mjs`).
 */

export const MINIMUM_NODE = '22.5';

/** What to print and exit on, or null when this Node is fine. */
export function nodeVersionError(version: string = process.versions.node): string | null {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) return null;

  return (
    `orca-viz needs Node >= ${MINIMUM_NODE} (you have v${version}).\n` +
    `  Node ${MINIMUM_NODE} is where node:sqlite landed, and it is the whole reason orca-viz installs with nothing to compile.\n` +
    `  Try: npx -y node@22 $(which npx) orca-viz`
  );
}

/**
 * `node:sqlite` prints an ExperimentalWarning on every process that imports it. It is
 * noise the user can do nothing about and did not ask for, and it lands on stderr right
 * where the chosen database path is supposed to be the first thing they read.
 *
 * Filtered at `process.emitWarning` rather than with `--disable-warning=ExperimentalWarning`
 * in the shebang: `env -S` is not portable to the shim npm generates on Windows.
 */
export function suppressExperimentalWarning(): void {
  const emit = process.emitWarning.bind(process);

  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const name = typeof warning === 'string' ? (rest[0] as string | undefined) : warning.name;
    const text = typeof warning === 'string' ? warning : warning.message;
    if (name === 'ExperimentalWarning' && text.includes('SQLite')) return;

    // Everything else is still the user's business.
    (emit as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

import { execFile, type ExecFileException } from 'node:child_process';
import { StartupError } from './errors.ts';

/**
 * `--tailscale` (#102) — bind this machine's tailnet address, and nothing else.
 *
 * The tool binds loopback by design (SPEC §6.4), and the database is why: it holds task specs,
 * agent prompts and message bodies. But the run you most want to watch from the couch is the one
 * happening on the machine you are not sitting at — and `discovery.ts` already tells people the
 * only way that can work, because WAL forbids reading the file across a filesystem boundary:
 * *run orca-viz on the machine Orca runs on, and browse to it over HTTP.*
 *
 * Before this flag, the only documented way to do that was `--host`, and the only value most
 * people know to put there is `0.0.0.0` — the one value the SPEC exists to prevent. So the tool
 * made the dangerous path the easy one. This flag exists to make the safe path easier than it.
 *
 * It is **not** ergonomics: `--host $(tailscale ip -4)` is a shell one-liner. `--host` names an
 * address; `--tailscale` states an *intent* — "my tailnet, and only my tailnet" — and an intent
 * is a thing the tool can check and refuse:
 *
 * - **One read, timeout-bounded.** `tailscale ip -4` is the whole command surface (`TAILSCALE_IP`).
 *   Nothing here may ever reach a `tailscale` subcommand that changes anything — `tailscale serve`
 *   above all, which writes state into `tailscaled` that **outlives this process**. A tool whose
 *   promise is that it never writes cannot be a tool that leaves a live network exposure behind it
 *   on a SIGKILL. That recipe belongs in the user's hands, deliberately (see the README).
 * - **Hard error, never a fallback** (the `--db` doctrine, SPEC §3 — and it matters more here than
 *   anywhere). The two things a failed resolution *could* fall back to are loopback, which silently
 *   breaks the URL the user came for, and `0.0.0.0`, which silently exposes them to the café. So a
 *   Tailscale that cannot answer — absent, stopped, logged out, slow — binds nothing at all.
 * - **`100.64.0.0/10`, or nothing.** Every tailnet IPv4 address lives in that CGNAT range; an
 *   answer outside it means we are not talking to what we think we are, whatever the reason. This
 *   is the check that makes it *impossible* for the flag to widen exposure: `0.0.0.0` is not a
 *   tailnet address, so `--tailscale` can never bind it, however the CLI is fooled or replaced.
 *
 * What the flag does **not** buy is authentication, because orca-viz has none. On loopback that is
 * a non-fact. On a tailnet it is the entire security model, it belongs to Tailscale's ACLs, and
 * `boot.ts` says so out loud every time the flag is used.
 */

/** The whole command surface of this flag, verbatim. It is a read, and it has no flags to add. */
export const TAILSCALE_IP = ['ip', '-4'] as const;

/** The CLI as the user's shell knows it. */
const TAILSCALE_BIN = 'tailscale';

/** Past this, a Tailscale that is not answering is an error, not a wait. */
export const TAILSCALE_TIMEOUT_MS = 3000;

/**
 * The one seam between this module and a process table. Resolves to stdout; rejects with a
 * *readable* reason. Injected so the suite can script a Tailscale that is missing, stopped or
 * logged out without needing one — and so it can prove which argv is ever asked for.
 */
export type RunTailscaleCommand = (args: readonly string[], timeoutMs: number) => Promise<string>;

export const runTailscaleCommand: RunTailscaleCommand = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      TAILSCALE_BIN,
      args as string[],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        reject(new Error(describeSpawnFailure(error, stderr)));
      }
    );
  });

/**
 * Why Tailscale did not answer, in words a terminal can print.
 *
 * Node's own message for a failed `execFile` is `Command failed: tailscale ip -4` followed by the
 * whole stderr — which buries the one line the user needs (`Tailscale is stopped.`, `logged out`)
 * under a command they did not type. The CLI's own words are better than ours whenever it had any,
 * so they win; we only supply a sentence where it said nothing at all.
 */
export function describeSpawnFailure(error: ExecFileException, stderr: string): string {
  if (error.code === 'ENOENT') {
    return `the \`${TAILSCALE_BIN}\` command is not installed, or not on PATH.`;
  }
  // A timeout kills the child, so there is no exit code and usually no stderr to quote.
  if (error.killed === true) {
    return `\`${TAILSCALE_BIN} ${TAILSCALE_IP.join(' ')}\` did not answer within ${TAILSCALE_TIMEOUT_MS} ms.`;
  }

  const said = stderr
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');

  return said ?? `\`${TAILSCALE_BIN} ${TAILSCALE_IP.join(' ')}\` failed (exit ${error.code ?? 'unknown'}).`;
}

/**
 * Tailscale's CGNAT range, `100.64.0.0/10` — where every tailnet IPv4 address lives, always.
 *
 * Strict on purpose. `Number('')` is 0 and `Number(' 1')` is 1, so a loose parse would read the
 * empty string as `0.0.0.0` given the chance; this is the last gate before an address becomes a
 * bind, and the whole safety of the flag rests on it saying no.
 */
export function isTailnetAddress(address: string): boolean {
  const octets = address.split('.');
  if (octets.length !== 4) return false;
  // No leading zeros: `010` is octal to some parsers and decimal to others, and an address two
  // readers can disagree about is not one this flag is willing to bind.
  if (!octets.every((octet) => /^(0|[1-9]\d{0,2})$/.test(octet))) return false;

  const values = octets.map(Number);
  if (values.some((octet) => octet > 255)) return false;

  const [first, second] = values as [number, number, number, number];
  return first === 100 && second >= 64 && second <= 127;
}

/**
 * The address `--tailscale` binds, or the error that stops the boot. There is no third outcome:
 * see the module comment for why neither fallback is one.
 */
export async function resolveTailnetAddress(run: RunTailscaleCommand): Promise<string> {
  let stdout: string;
  try {
    stdout = await run(TAILSCALE_IP, TAILSCALE_TIMEOUT_MS);
  } catch (error) {
    throw new StartupError(
      `--tailscale cannot reach Tailscale: ${(error as Error).message}`,
      'orca-viz will not fall back to loopback (the URL you came for would stop working) or to 0.0.0.0 (you would be serving your task specs and agent prompts to whatever network you are on). Start Tailscale, or pass --host yourself.'
    );
  }

  const answer = stdout.split('\n')[0]?.trim() ?? '';
  if (!isTailnetAddress(answer)) {
    throw new StartupError(
      `--tailscale expects a tailnet address in 100.64.0.0/10, but \`${TAILSCALE_BIN} ${TAILSCALE_IP.join(' ')}\` answered ${answer === '' ? 'nothing' : `"${clip(answer)}"`}.`,
      'orca-viz binds an address it can confirm belongs to your tailnet, or none at all. Pass --host to bind something else, and mean it.'
    );
  }

  return answer;
}

/** An unrecognisable answer is quoted back, not pasted back: it can be any length at all. */
function clip(answer: string): string {
  return answer.length <= 60 ? answer : `${answer.slice(0, 60)}…`;
}

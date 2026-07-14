import type { ExecFileException } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { StartupError } from '../../src/server/errors.ts';
import {
  describeSpawnFailure,
  isTailnetAddress,
  resolveTailnetAddress,
  type RunTailscaleCommand,
  TAILSCALE_IP,
  TAILSCALE_TIMEOUT_MS,
} from '../../src/server/tailnet.ts';

/**
 * `--tailscale` (#102), tested at its seam: a scripted `tailscale` CLI in, a bind address — or a
 * refusal — out.
 *
 * The refusals are the feature. Every test below that asserts a throw is asserting the same thing
 * in a different disguise: **there is no answer this module turns into a bind it cannot vouch for.**
 * A flag whose whole purpose is to keep a database off the wrong network fails closed, or it is
 * worse than the `--host 0.0.0.0` it exists to replace.
 */

/** A Tailscale that answers with whatever the test says it answers. */
function answering(stdout: string): { run: RunTailscaleCommand; asked: { args: readonly string[]; timeoutMs: number }[] } {
  const asked: { args: readonly string[]; timeoutMs: number }[] = [];
  return {
    asked,
    run: (args, timeoutMs) => {
      asked.push({ args, timeoutMs });
      return Promise.resolve(stdout);
    },
  };
}

/** A Tailscale that is not there, or not running, or not logged in. */
function failing(message: string): RunTailscaleCommand {
  return () => Promise.reject(new Error(message));
}

describe('resolving the tailnet address', () => {
  it('binds the address the CLI prints', async () => {
    const { run } = answering('100.121.17.93\n');

    await expect(resolveTailnetAddress(run)).resolves.toBe('100.121.17.93');
  });

  it('asks for exactly one thing, and does not wait forever for it', async () => {
    const { run, asked } = answering('100.64.0.1\n');

    await resolveTailnetAddress(run);

    // The whole command surface of this flag. `tailscale serve` writes state that outlives this
    // process, and a tool that never writes cannot be a tool that leaves a serve config behind.
    expect(asked).toEqual([{ args: TAILSCALE_IP, timeoutMs: TAILSCALE_TIMEOUT_MS }]);
    expect(TAILSCALE_IP).toEqual(['ip', '-4']);
  });
});

describe('a Tailscale that cannot answer', () => {
  it('is a startup error, and never a quiet fall back to loopback or 0.0.0.0', async () => {
    // The two fallbacks a lazier flag would reach for are both silent disasters: loopback breaks
    // the URL the user came for, and 0.0.0.0 serves their agents' prompts to the café.
    const error = await resolveTailnetAddress(failing('Tailscale is stopped.')).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(StartupError);
    expect((error as StartupError).message).toContain('Tailscale is stopped.');
    expect((error as StartupError).hint).toContain('0.0.0.0');
  });

  it('carries the words the CLI itself used, because they are better than ours', async () => {
    await expect(resolveTailnetAddress(failing('not logged in, run `tailscale up`'))).rejects.toThrow(
      /not logged in/
    );
  });
});

describe('an answer that is not a tailnet address', () => {
  it('refuses 0.0.0.0 — the one address this flag exists to never bind', async () => {
    const { run } = answering('0.0.0.0\n');

    // The check that makes widening exposure *impossible*, not merely unlikely: 0.0.0.0 is not in
    // 100.64.0.0/10, so no CLI — broken, replaced, or lying — can talk this flag into binding it.
    await expect(resolveTailnetAddress(run)).rejects.toThrow(/100\.64\.0\.0\/10/);
  });

  it('refuses a LAN address, however plausible it looks', async () => {
    const { run } = answering('192.168.1.14\n');

    await expect(resolveTailnetAddress(run)).rejects.toThrow(StartupError);
  });

  it('refuses silence', async () => {
    const { run } = answering('\n');

    // `Number('')` is 0, so a loose parse reads the empty string as 0.0.0.0 given the chance.
    await expect(resolveTailnetAddress(run)).rejects.toThrow(/answered nothing/);
  });

  it('quotes an unrecognisable answer back instead of pasting it back', async () => {
    const { run } = answering(`${'x'.repeat(500)}\n`);

    const error = (await resolveTailnetAddress(run).catch((thrown: unknown) => thrown)) as StartupError;
    expect(error.message).toContain('…');
    expect(error.message.length).toBeLessThan(300);
  });
});

describe('the CGNAT range', () => {
  it('accepts every address a tailnet can hand out, and nothing else', () => {
    // 100.64.0.0/10 — the whole range, and both of its edges.
    expect(isTailnetAddress('100.64.0.0')).toBe(true);
    expect(isTailnetAddress('100.127.255.255')).toBe(true);
    expect(isTailnetAddress('100.121.17.93')).toBe(true);

    expect(isTailnetAddress('100.63.255.255')).toBe(false); // One below the range.
    expect(isTailnetAddress('100.128.0.0')).toBe(false); // One above it.
    expect(isTailnetAddress('101.64.0.1')).toBe(false);
    expect(isTailnetAddress('10.0.0.1')).toBe(false);
    expect(isTailnetAddress('127.0.0.1')).toBe(false);
  });

  it('is not fooled by things that parse like addresses but are not', () => {
    expect(isTailnetAddress('')).toBe(false);
    expect(isTailnetAddress('100.64.0')).toBe(false);
    expect(isTailnetAddress('100.64.0.1.5')).toBe(false);
    expect(isTailnetAddress('100.64.0.256')).toBe(false);
    expect(isTailnetAddress(' 100.64.0.1')).toBe(false);
    expect(isTailnetAddress('100.64.0.1:4269')).toBe(false);
    expect(isTailnetAddress('100.070.0.1')).toBe(false); // Octal to some readers, decimal to others.
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(false); // The v6 half of the same tailnet.
  });
});

describe('what the terminal is told when the spawn fails', () => {
  /** As `execFile` hands a failure over: an exit code, a kill flag, and whatever it printed. */
  function failure(fields: Partial<ExecFileException>): ExecFileException {
    return { name: 'Error', message: 'Command failed: tailscale ip -4', ...fields };
  }

  it('says the CLI is missing when it is missing', () => {
    expect(describeSpawnFailure(failure({ code: 'ENOENT' }), '')).toMatch(/not installed|not on PATH/);
  });

  it('says it timed out when it timed out, rather than quoting an empty stderr', () => {
    expect(describeSpawnFailure(failure({ killed: true, signal: 'SIGTERM' }), '')).toContain(
      String(TAILSCALE_TIMEOUT_MS)
    );
  });

  it('quotes what the CLI said, not what Node said about the CLI', () => {
    // Node's own message is `Command failed: tailscale ip -4` and then the stderr — which buries
    // the one line the user needs under a command they never typed.
    const said = describeSpawnFailure(failure({ code: 1 }), '\nTailscale is stopped.\n');

    expect(said).toBe('Tailscale is stopped.');
  });

  it('still says something when the CLI failed silently', () => {
    expect(describeSpawnFailure(failure({ code: 1 }), '')).toContain('exit 1');
  });
});

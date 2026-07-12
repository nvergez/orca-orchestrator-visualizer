import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import {
  joinWorkers,
  OrcaEnrichment,
  parseTerminalList,
  parseWorktreePs,
  TERMINAL_LIST,
  WORKTREE_PS,
  type OrcaView,
  type RunOrcaCommand,
} from '../../src/server/enrichment.ts';
import { EventStream, type StreamClient, type StreamSource } from '../../src/server/stream.ts';
import type { Liveness, StreamEvent } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Live Orca enrichment (#61): explicit opt-in context from `orca worktree ps --json`, joined
 * to a worker by **exact terminal handle** and nothing else — never prompt text, display
 * names or timing.
 *
 * The three seams, from the inside out:
 *
 * 1. **The join** — a pure function over parsed CLI output. `terminal list` is the only
 *    place a handle ↔ worktree relationship exists (the ps `agents[]` carry pane keys, not
 *    handles), so worktree context needs an exact handle → worktreeId hit, and *activity*
 *    additionally needs the join to be unambiguous: one agent, one terminal, and the
 *    terminal is the worker's.
 * 2. **The adapter** — separately timed, timeout-bounded, cached, off the SQLite poll path,
 *    and running **no command at all** while Orca is not live.
 * 3. **The wire** — the real server over real HTTP: opt-in absence, honest failure, and a
 *    SQLite snapshot whose delivery a hung CLI cannot delay.
 */

const WORKER = handleFor('worker');
const OTHER = handleFor('other-worker');
const COORDINATOR = handleFor('coordinator');

/** A ps worktree as `orca worktree ps --json` really shapes it (verified live). */
function psWorktree(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    worktreeId: 'repo-1::/home/dev/orca/workspaces/viz/issue-61',
    path: '/home/dev/orca/workspaces/viz/issue-61',
    branch: 'refs/heads/nvergez/issue-61',
    repo: 'orca-viz',
    displayName: 'issue-61',
    liveTerminalCount: 1,
    agents: [
      {
        paneKey: 'aaaa:bbbb',
        state: 'working',
        agentType: 'claude',
        taskTitle: 'Implement issue #61',
        lastAssistantMessage: 'Running the suite now.',
        toolName: 'Bash',
        toolInput: 'npm test',
        updatedAt: 1783892546982,
      },
    ],
    ...over,
  };
}

function terminal(handle: string, worktreeId = 'repo-1::/home/dev/orca/workspaces/viz/issue-61') {
  return { handle, worktreeId, ptyId: '3' };
}

function view(worktrees: unknown[], terminals: unknown[]): OrcaView {
  return {
    worktrees: parseWorktreePs(JSON.stringify({ ok: true, result: { worktrees } })),
    terminals: parseTerminalList(JSON.stringify({ ok: true, result: { terminals } })),
  };
}

describe('the exact terminal-handle join', () => {
  it('attaches worktree and activity when the handle joins one terminal, alone with one agent', () => {
    const workers = joinWorkers([WORKER], view([psWorktree()], [terminal(WORKER)]));

    expect(workers).toEqual([
      {
        handle: WORKER,
        worktree: {
          path: '/home/dev/orca/workspaces/viz/issue-61',
          branch: 'nvergez/issue-61', // refs/heads/ stripped — it is a label, not a ref
          repo: 'orca-viz',
          displayName: 'issue-61',
        },
        activity: {
          state: 'working',
          agentType: 'claude',
          taskTitle: 'Implement issue #61',
          lastAssistantMessage: 'Running the suite now.',
          toolName: 'Bash',
          toolInput: 'npm test',
          updatedAt: new Date(1783892546982).toISOString(),
        },
      },
    ]);
  });

  it('renders no worker at all for a handle the terminal list does not name', () => {
    // The handle is the only join key this feature is allowed (#61 out of scope: prompt
    // text, display names, timing). A worker whose terminal is gone gets nothing — not a
    // guess from the worktree that "looks right".
    expect(joinWorkers([WORKER], view([psWorktree()], [terminal(OTHER)]))).toEqual([]);
  });

  it('attaches the worktree but no activity when other terminals share the worktree', () => {
    const shared = view(
      [psWorktree({ liveTerminalCount: 2 })],
      [terminal(WORKER), terminal(OTHER)] // two terminals, one agent — whose is it?
    );

    const workers = joinWorkers([WORKER], shared);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.worktree.displayName).toBe('issue-61');
    expect(workers[0]!.activity).toBeUndefined();
  });

  it('attaches no activity when several agents run in the joined worktree', () => {
    const crowded = view(
      [
        psWorktree({
          agents: [
            { paneKey: 'a:a', state: 'working' },
            { paneKey: 'b:b', state: 'done' },
          ],
        }),
      ],
      [terminal(WORKER)]
    );

    const workers = joinWorkers([WORKER], crowded);
    expect(workers[0]!.worktree.path).toBe('/home/dev/orca/workspaces/viz/issue-61');
    expect(workers[0]!.activity).toBeUndefined();
  });

  it('attaches no activity when the CLI counts live terminals the terminal list cannot name', () => {
    // Verified live: a worktree can report liveTerminalCount 3 while `terminal list` shows
    // no entry for it at all — unnamed terminals exist, and the single agent could be in
    // any of them. One terminal-list entry is not enough on its own.
    const undercounted = view([psWorktree({ liveTerminalCount: 3 })], [terminal(WORKER)]);

    expect(joinWorkers([WORKER], undercounted)[0]!.activity).toBeUndefined();
  });

  it('attaches no activity when the terminal count is missing — drift never becomes a guess', () => {
    const drifted = view([psWorktree({ liveTerminalCount: undefined })], [terminal(WORKER)]);

    expect(joinWorkers([WORKER], drifted)[0]!.activity).toBeUndefined();
  });

  it('enriches only the handles it was asked about', () => {
    // `terminal list` names every terminal on the machine; the snapshot names its workers.
    // Context for a terminal no orchestration row points at would be wire spent on nobody.
    const both = view([psWorktree()], [terminal(WORKER), terminal(OTHER)]);

    expect(joinWorkers([OTHER], both).map((worker) => worker.handle)).toEqual([OTHER]);
  });
});

describe('parsing the CLI output', () => {
  it('rejects an envelope that is not ok, and containers that are not arrays', () => {
    expect(() => parseWorktreePs(JSON.stringify({ ok: false, error: 'nope' }))).toThrow();
    expect(() => parseWorktreePs(JSON.stringify({ ok: true, result: { worktrees: 'what' } }))).toThrow();
    expect(() => parseTerminalList(JSON.stringify({ ok: true, result: {} }))).toThrow();
    expect(() => parseWorktreePs('not json at all {')).toThrow();
  });

  it('skips entries missing their identity fields rather than failing the whole read', () => {
    const terminals = parseTerminalList(
      JSON.stringify({
        ok: true,
        result: { terminals: [terminal(WORKER), { handle: 42, worktreeId: 'x' }, { handle: 'term_y' }] },
      })
    );
    expect(terminals).toHaveLength(1);

    const worktrees = parseWorktreePs(
      JSON.stringify({ ok: true, result: { worktrees: [psWorktree(), { path: 123 }] } })
    );
    expect(worktrees).toHaveLength(1);
  });

  it('caps the activity previews — the snapshot is re-sent whole every tick (SPEC §6.3)', () => {
    const long = 'x'.repeat(10_000);
    const [worktree] = parseWorktreePs(
      JSON.stringify({
        ok: true,
        result: { worktrees: [psWorktree({ agents: [{ state: 'working', toolInput: long, lastAssistantMessage: long }] })] },
      })
    );

    const agent = worktree!.agents![0]!;
    expect(agent.toolInput!.length).toBeLessThanOrEqual(240);
    expect(agent.lastAssistantMessage!.length).toBeLessThanOrEqual(240);
  });
});

/** An adapter test double: liveness the test controls, a CLI the test scripts. */
function fakeCli(
  respond: (args: readonly string[]) => string | Promise<string>
): RunOrcaCommand & { calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const run = async (args: readonly string[]) => {
    calls.push(args);
    return respond(args);
  };
  return Object.assign(run, { calls });
}

function goodCli(worktrees: unknown[] = [psWorktree()], terminals: unknown[] = [terminal(WORKER)]) {
  return fakeCli((args) =>
    JSON.stringify(
      args === WORKTREE_PS || args[0] === 'worktree'
        ? { ok: true, result: { worktrees } }
        : { ok: true, result: { terminals } }
    )
  );
}

describe('the adapter', () => {
  it('runs no command while Orca is not live, and says the live-only path is suspended', async () => {
    const cli = goodCli();
    const adapter = new OrcaEnrichment(() => 'stale' as Liveness, { run: cli });

    await adapter.refresh();

    expect(cli.calls).toEqual([]);
    expect(adapter.enrich([WORKER])).toEqual({ state: 'suspended', fetchedAt: null, workers: [] });
  });

  it('asks exactly the two read-only commands, and caches the answer between refreshes', async () => {
    const cli = goodCli();
    const adapter = new OrcaEnrichment(() => 'live', { run: cli });

    await adapter.refresh();

    // The whole command surface of this tool: two reads, nothing that could mutate
    // orchestration or mailbox state (SPEC §1.2 — `orca orchestration check` marks read).
    expect(cli.calls).toEqual([WORKTREE_PS, TERMINAL_LIST]);

    // Two snapshots between refreshes are two joins against one cached answer — the CLI is
    // not asked once per snapshot, or once per subscriber.
    const first = adapter.enrich([WORKER]);
    const second = adapter.enrich([WORKER]);
    expect(cli.calls).toHaveLength(2);

    expect(first.state).toBe('ok');
    expect(first.fetchedAt).not.toBeNull();
    expect(first.workers[0]!.handle).toBe(WORKER);
    expect(second.workers).toEqual(first.workers);
  });

  it('reports pending before the first answer lands, with the join empty and honest', () => {
    const adapter = new OrcaEnrichment(() => 'live', { run: goodCli() });

    expect(adapter.enrich([WORKER])).toEqual({ state: 'pending', fetchedAt: null, workers: [] });
  });

  it('marks enrichment unavailable when the CLI times out, and recovers on the next good read', async () => {
    let hang = true;
    const cli = fakeCli(() => {
      if (hang) return Promise.reject(new Error('orca worktree ps timed out after 50ms'));
      return JSON.stringify({ ok: true, result: { worktrees: [psWorktree()], terminals: [terminal(WORKER)] } });
    });
    const adapter = new OrcaEnrichment(() => 'live', { run: cli });

    await adapter.refresh();
    expect(adapter.enrich([WORKER])).toEqual({ state: 'unavailable', fetchedAt: null, workers: [] });

    hang = false;
    await adapter.refresh();
    expect(adapter.enrich([WORKER]).state).toBe('ok');
  });

  it('marks enrichment unavailable on malformed JSON and on schema drift', async () => {
    const malformed = new OrcaEnrichment(() => 'live', { run: fakeCli(() => 'garbage {{') });
    await malformed.refresh();
    expect(malformed.enrich([WORKER]).state).toBe('unavailable');

    // Drift: the envelope parses but the containers are not what this build understands.
    const drifted = new OrcaEnrichment(() => 'live', {
      run: fakeCli(() => JSON.stringify({ ok: true, result: { panes: [] } })),
    });
    await drifted.refresh();
    expect(drifted.enrich([WORKER]).state).toBe('unavailable');
  });

  it('bumps its generation only when the answer changed — an idle refresh pushes nobody', async () => {
    let state = 'working';
    const cli = fakeCli((args) =>
      JSON.stringify(
        args[0] === 'worktree'
          ? { ok: true, result: { worktrees: [psWorktree({ agents: [{ paneKey: 'a:a', state }] })] } }
          : { ok: true, result: { terminals: [terminal(WORKER)] } }
      )
    );
    const adapter = new OrcaEnrichment(() => 'live', { run: cli });

    await adapter.refresh();
    const afterFirst = adapter.generation;

    await adapter.refresh(); // same answer — same generation, or every interval is a no-op push
    expect(adapter.generation).toBe(afterFirst);

    state = 'done';
    await adapter.refresh();
    expect(adapter.generation).toBeGreaterThan(afterFirst);
  });

  it('drops the cache when Orca stops being live — handles die with the app they belonged to', async () => {
    let liveness: Liveness = 'live';
    const adapter = new OrcaEnrichment(() => liveness, { run: goodCli() });

    await adapter.refresh();
    expect(adapter.enrich([WORKER]).state).toBe('ok');

    liveness = 'stale';
    await adapter.refresh();

    // Terminal handles are ephemeral: resurrecting pre-shutdown context after a restart
    // would join yesterday's activity to today's identically-named nothing.
    expect(adapter.enrich([WORKER])).toEqual({ state: 'suspended', fetchedAt: null, workers: [] });
  });

  it('bounds the real command with the timeout it was given', async () => {
    const adapter = new OrcaEnrichment(() => 'live', {
      run: (args, timeoutMs) =>
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), 5)),
      timeoutMs: 50,
    });

    await adapter.refresh();
    expect(adapter.enrich([WORKER]).state).toBe('unavailable');
  });
});

/** A counting stream source whose enrichment generation the test moves by hand. */
function stubSource(): StreamSource & { bump(): void; reads: { snapshots: number } } {
  let generation = 0;
  const reads = { snapshots: 0 };
  const event = (): StreamEvent => ({
    seq: 0,
    meta: {
      dbPath: '/tmp/db',
      schemaVersion: 5,
      schemaSupport: 'supported',
      degraded: [],
      liveness: 'live',
      orcaPid: 1,
      dbMtime: new Date(0).toISOString(),
      resetDetected: false,
    },
    snapshot: { runs: [], tasks: [], gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  });

  return {
    dataVersion: () => 1,
    liveness: () => 'live',
    enrichmentVersion: () => generation,
    snapshot: () => {
      reads.snapshots += 1;
      return event();
    },
    bump: () => {
      generation += 1;
    },
    reads,
  };
}

describe('pushing enrichment changes', () => {
  it('pushes when only the enrichment generation moved — the DAG data was never the signal', () => {
    const source = stubSource();
    const stream = new EventStream(source, 60_000);
    const sent: StreamEvent[] = [];
    const client: StreamClient = { send: (event) => sent.push(event), end: () => {} };

    stream.subscribe(client);
    expect(sent).toHaveLength(1);

    stream.tick(); // nothing changed — silence, exactly as before #61
    expect(sent).toHaveLength(1);

    source.bump();
    stream.tick();
    expect(sent).toHaveLength(2);

    stream.tick(); // and the change is not re-pushed
    expect(sent).toHaveLength(2);

    stream.close();
  });
});

describe('the wire', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  function fixture(): string {
    const dbPath = new FixtureBuilder()
      .task({
        id: 'task_build',
        handle: COORDINATOR,
        title: 'Build it',
        status: 'dispatched',
        createdAt: new Date('2026-07-08T12:00:00Z'),
      })
      .dispatch({
        taskId: 'task_build',
        assigneeHandle: WORKER,
        status: 'dispatched',
        dispatchedAt: new Date('2026-07-08T12:01:00Z'),
      })
      .write(tempDbPath());
    writeFileSync(join(dirname(dbPath), 'orca-runtime.json'), JSON.stringify({ pid: 4242 }));
    return dbPath;
  }

  it('ships no enrichment field at all while the opt-in is off', async () => {
    harness = await serve(fixture(), { probe: () => true });

    const event = await harness.snapshot();
    expect('enrichment' in event).toBe(false);
  });

  it('joins live context onto the snapshot workers when opted in', async () => {
    harness = await serve(fixture(), { probe: () => true, enrichment: { run: goodCli() } });

    // The adapter refreshes off the poll path; give its first answer a moment to land.
    const event = await waitFor(async () => {
      const got = await harness!.snapshot();
      if (got.enrichment?.state !== 'ok') throw new Error(`still ${got.enrichment?.state}`);
      return got;
    });

    expect(event.enrichment!.workers.map((worker) => worker.handle)).toEqual([WORKER]);
    expect(event.enrichment!.workers[0]!.activity?.toolName).toBe('Bash');
    // And the SQLite side is exactly what the un-enriched server would have said.
    expect(event.snapshot.tasks).toHaveLength(1);
  });

  it('delivers the complete SQLite snapshot promptly while the CLI hangs forever', async () => {
    const never: RunOrcaCommand = () => new Promise(() => {});
    harness = await serve(fixture(), { probe: () => true, enrichment: { run: never } });

    const started = Date.now();
    const event = await harness.snapshot();

    // The whole acceptance criterion in two assertions: the SQLite state is complete and on
    // time, and the enrichment says honestly that it has nothing yet.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(event.snapshot.tasks).toHaveLength(1);
    expect(event.snapshot.runs).toHaveLength(1);
    expect(event.enrichment).toEqual({ state: 'pending', fetchedAt: null, workers: [] });
  });

  it('keeps the snapshot whole and labels enrichment unavailable when the CLI fails', async () => {
    harness = await serve(fixture(), {
      probe: () => true,
      enrichment: { run: () => Promise.reject(new Error('exit code 1')) },
    });

    const event = await waitFor(async () => {
      const got = await harness!.snapshot();
      if (got.enrichment?.state !== 'unavailable') throw new Error(`still ${got.enrichment?.state}`);
      return got;
    });

    expect(event.snapshot.tasks).toHaveLength(1);
    expect(event.enrichment).toEqual({ state: 'unavailable', fetchedAt: null, workers: [] });
  });
});

/** Poll an async assertion the way the browser polls the stream: until it stops throwing. */
async function waitFor<T>(read: () => Promise<T>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

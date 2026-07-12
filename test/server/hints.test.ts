import { afterEach, describe, expect, it } from 'vitest';
import { branchKinds, declaredKinds, projectCandidates } from '../../src/server/hints.ts';
import type { CastMember, Run } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * **Evidence hints** (SPEC §12.4): explicitly uncertain agent-kind and repository labels, derived
 * only from unambiguous high-confidence retained evidence, with provenance — and refused otherwise.
 *
 * The whole feature is its refusals, and the live database is why. Real specs say *"You are a
 * Claude Code agent … never launch Codex"* — a prose scan would read that as two kinds and either
 * guess or, worse, pick one. Real results say `{"reason": "codex workspace out of credits"}` on a
 * task a Claude agent completed. The readers therefore inspect **defined positions only** — the
 * `you are a <kind>` declaration, a delimited branch segment, the `workspaces/<project>/<worktree>`
 * layout — and a kind or project that does not survive as the *only* candidate produces no hint.
 *
 * Two seams, as SPEC §12.5 prescribes: the readers are pure functions with a dense error surface
 * (unique / absent / malformed / ambiguous / archived evidence), and the aggregation is asserted
 * through the real HTTP snapshot, where the hint has to land on the wire without touching any
 * identity it rides beside.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;

const ORCHESTRATOR = handleFor('orchestrator');
const ALICE = handleFor('alice');
const BOB = handleFor('bob');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

async function runsOf(builder: FixtureBuilder): Promise<Run[]> {
  harness = await serve(builder.write(tempDbPath()));
  return (await harness.snapshot()).snapshot.runs;
}

function byHandle(runs: Run[], handle: string | null): Run {
  const run = runs.find((candidate) => candidate.handle === handle);
  if (!run) throw new Error(`no run for handle ${handle} in the snapshot`);
  return run;
}

function member(run: Run, handle: string): CastMember {
  const found = run.cast.find((candidate) => candidate.handle === handle);
  if (!found) throw new Error(`no cast member ${handle}`);
  return found;
}

describe('declaredKinds: the "you are a <kind>" position in a spec', () => {
  it('reads the declared kind, and refuses the casual mention two clauses later', () => {
    // Verbatim from the live database. A prose scan would find claude AND codex here, and the
    // conflict would kill the hint for the one spec position that could not be clearer.
    const spec =
      'You are a Claude Code agent; do the work yourself in this worktree and never launch Codex ' +
      '(the Codex workspace is out of credits). If you delegate anything, use Claude agents only.';

    expect(declaredKinds(spec)).toEqual(['claude']);
  });

  it('reads a declaration without an article', () => {
    expect(declaredKinds('You are Claude Code, working in a worktree.')).toEqual(['claude']);
  });

  it('is case-insensitive, and reports the kind in its allowlist casing', () => {
    expect(declaredKinds('you are a CODEX agent')).toEqual(['codex']);
  });

  it('finds nothing in a declaration of an unlisted kind', () => {
    expect(declaredKinds('You are an autonomous coding agent.')).toEqual([]);
  });

  it('finds nothing in instructions that merely mention a kind', () => {
    // "Use Codex agents only for any delegation" is about who the worker may SPAWN — the live
    // database says it to Claude workers. It is not a declaration of the worker's own kind.
    expect(declaredKinds('Use Codex agents only for any delegation.')).toEqual([]);
  });

  it('reports both kinds when a spec declares twice — the conflict is the caller’s to refuse', () => {
    expect(declaredKinds('You are a Claude agent. Later: you are a Codex agent.')).toEqual(['claude', 'codex']);
  });

  it('deduplicates repeated declarations of one kind', () => {
    expect(declaredKinds('You are a Claude agent. Remember: you are a claude agent.')).toEqual(['claude']);
  });

  it('finds nothing in an empty spec', () => {
    expect(declaredKinds('')).toEqual([]);
  });
});

describe('branchKinds: a delimited segment of a branch name', () => {
  it('reads a kind suffix', () => {
    // Verbatim from a live worker_done payload: {"branch": "nvergez/94-codex"}.
    expect(branchKinds('nvergez/94-codex')).toEqual(['codex']);
  });

  it('reads a kind prefix segment', () => {
    expect(branchKinds('claude/fix-canvas')).toEqual(['claude']);
  });

  it('refuses a substring — a token is a whole delimited segment or it is nothing', () => {
    expect(branchKinds('fix/claudette-rename')).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(branchKinds('Claude/Fix-Things')).toEqual(['claude']);
  });

  it('reports every kind a branch names — the conflict is the caller’s to refuse', () => {
    expect(branchKinds('claude-vs-codex/bench')).toEqual(['claude', 'codex']);
  });
});

describe('projectCandidates: the workspaces/<project>/<worktree> position in an absolute path', () => {
  it('reads the project out of an Orca worktree path in prose', () => {
    expect(projectCandidates('Work in /home/dev/orca/workspaces/orca-viz/issue-73-wt only.')).toEqual(['orca-viz']);
  });

  it('deduplicates several paths naming one project', () => {
    const text =
      'The worktrees exist at /home/dev/orca/workspaces/orchestrator/bench-93-codex and ' +
      '/home/dev/orca/workspaces/orchestrator/bench-93-claude — run verification there.';

    expect(projectCandidates(text)).toEqual(['orchestrator']);
  });

  it('reports every project the text names — the ambiguity is the caller’s to refuse', () => {
    const text = 'Read /home/dev/orca/workspaces/one/wt-a then /home/dev/orca/workspaces/two/wt-b.';

    expect(projectCandidates(text)).toEqual(['one', 'two']);
  });

  it('reads a path out of retained JSON text', () => {
    expect(projectCandidates('{"filesModified":["/home/dev/orca/workspaces/orca-viz/wt-1/src/a.ts"]}')).toEqual([
      'orca-viz',
    ]);
  });

  it('reads an archived path — evidence is retained strings, never the filesystem', () => {
    // This worktree does not exist on any machine. Repo extraction must keep working in archived
    // replay and after cleanup, so nothing here may stat, resolve, or otherwise consult the disk.
    expect(projectCandidates('Built in /home/nobody/orca/workspaces/long-archived-project/wt-9.')).toEqual([
      'long-archived-project',
    ]);
  });

  it('reads a Windows worktree path', () => {
    expect(projectCandidates('Assigned worktree: C:\\Users\\me\\orca\\workspaces\\proj\\wt-1')).toEqual(['proj']);
  });

  it('refuses a relative path — high-confidence evidence is absolute', () => {
    expect(projectCandidates('see workspaces/foo/bar for details')).toEqual([]);
  });

  it('refuses a URL path — github.com/x/workspaces/y is not a filesystem', () => {
    expect(projectCandidates('https://github.com/acme/workspaces/tree/main/foo')).toEqual([]);
  });

  it('refuses a path that stops at the project — the layout is workspaces/<project>/<worktree>', () => {
    expect(projectCandidates('the root is /home/dev/orca/workspaces/orca-viz')).toEqual([]);
  });

  it('refuses a dot segment at the project position', () => {
    expect(projectCandidates('moved to /home/dev/orca/workspaces/.trash/old-wt')).toEqual([]);
  });

  it('finds nothing in a path without the layout', () => {
    expect(projectCandidates('report at /tmp/claude-1000/scratchpad/report.md')).toEqual([]);
  });
});

describe('agent-kind hints on the wire', () => {
  it('hints from a unique spec declaration, with its provenance', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'You are a Claude Code agent; ship it.', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
    );

    expect(member(byHandle(runs, ORCHESTRATOR), ALICE).kindHint).toEqual({ value: 'claude', sources: ['spec'] });
  });

  it('hints from a worker_done branch, attributed to the agent that sent it', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .task({ id: 'task_2', handle: ORCHESTRATOR, createdAt: at(MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_2', assigneeHandle: BOB, dispatchedAt: at(2 * MINUTE) })
        .message({
          fromHandle: ALICE,
          toHandle: ORCHESTRATOR,
          type: 'worker_done',
          subject: 'done',
          payload: { taskId: 'task_1', branch: 'nvergez/94-codex' },
          createdAt: at(3 * MINUTE),
        })
    );

    const run = byHandle(runs, ORCHESTRATOR);
    expect(member(run, ALICE).kindHint).toEqual({ value: 'codex', sources: ['branch'] });
    // The branch names Alice's kind, not Bob's — evidence never spreads past its sender.
    expect(member(run, BOB).kindHint).toBeUndefined();
  });

  it('hints from a result branch, attributed to the latest attempt’s assignee only', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: ORCHESTRATOR,
          status: 'completed',
          spec: 'no declaration here',
          result: '{"branch":"nvergez/96-claude","head":"dfd2c24"}',
          createdAt: at(0),
          completedAt: at(9 * MINUTE),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, status: 'failed', dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_1', assigneeHandle: BOB, status: 'completed', dispatchedAt: at(5 * MINUTE) })
    );

    const run = byHandle(runs, ORCHESTRATOR);
    // The result is the surviving attempt's report. Alice's attempt failed before it was written,
    // so reading it as evidence of HER kind would be a guess about the wrong agent.
    expect(member(run, ALICE).kindHint).toBeUndefined();
    expect(member(run, BOB).kindHint).toEqual({ value: 'claude', sources: ['branch'] });
  });

  it('merges provenance when independent sources agree on one kind', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'You are a Claude Code agent.', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          fromHandle: ALICE,
          toHandle: ORCHESTRATOR,
          type: 'worker_done',
          subject: 'done',
          payload: { taskId: 'task_1', branch: 'nvergez/96-claude' },
          createdAt: at(2 * MINUTE),
        })
    );

    expect(member(byHandle(runs, ORCHESTRATOR), ALICE).kindHint).toEqual({
      value: 'claude',
      sources: ['spec', 'branch'],
    });
  });

  it('refuses conflicting evidence — a hint is one surviving kind or nothing', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'You are a Claude Code agent.', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          fromHandle: ALICE,
          toHandle: ORCHESTRATOR,
          type: 'worker_done',
          subject: 'done',
          payload: { taskId: 'task_1', branch: 'nvergez/94-codex' },
          createdAt: at(2 * MINUTE),
        })
    );

    expect(member(byHandle(runs, ORCHESTRATOR), ALICE).kindHint).toBeUndefined();
  });

  it('refuses absent evidence — and the field is absent from the wire, not null', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'ship the feature', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
    );

    // Absent-when-default, like every optional snapshot field (SPEC §6.3): the snapshot is re-sent
    // whole every tick, and `"kindHint":null` on every member of every cast would be bytes of nothing.
    expect('kindHint' in member(byHandle(runs, ORCHESTRATOR), ALICE)).toBe(false);
  });

  it('refuses casual mentions and prose fields end to end', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: ORCHESTRATOR,
          // Both shapes are verbatim live data: an instruction that names a kind without declaring
          // one, and a result whose prose `reason` names the OTHER kind. A worker of unknown kind
          // wrote this; only a scan of undefined positions would claim to know which.
          spec: 'Never launch Codex; the Codex workspace is out of credits.',
          result: '{"reason":"codex workspace out of credits; worked around it"}',
          status: 'completed',
          createdAt: at(0),
          completedAt: at(9 * MINUTE),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
    );

    expect(member(byHandle(runs, ORCHESTRATOR), ALICE).kindHint).toBeUndefined();
  });

  it('survives malformed evidence — bad JSON is no evidence, never a crash', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: ORCHESTRATOR,
          result: '{"branch": not json at all',
          status: 'completed',
          createdAt: at(0),
          completedAt: at(9 * MINUTE),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .message({
          fromHandle: ALICE,
          toHandle: ORCHESTRATOR,
          type: 'worker_done',
          subject: 'done',
          payload: { taskId: 'task_1', branch: 42 },
          createdAt: at(2 * MINUTE),
        })
    );

    expect(member(byHandle(runs, ORCHESTRATOR), ALICE).kindHint).toBeUndefined();
  });
});

describe('repository hints on the wire', () => {
  it('hints when every absolute-path candidate in the run agrees on one project', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: ORCHESTRATOR,
          spec: 'Work only in /home/dev/orca/workspaces/orca-viz/issue-73-wt.',
          createdAt: at(0),
        })
        .task({
          id: 'task_2',
          handle: ORCHESTRATOR,
          spec: 'Review the diff in /home/dev/orca/workspaces/orca-viz/issue-74-wt.',
          createdAt: at(MINUTE),
        })
    );

    expect(byHandle(runs, ORCHESTRATOR).repoHint).toEqual({ value: 'orca-viz', sources: ['task specs'] });
  });

  it('merges provenance when specs and results agree', async () => {
    const runs = await runsOf(
      new FixtureBuilder().task({
        id: 'task_1',
        handle: ORCHESTRATOR,
        spec: 'Work in /home/dev/orca/workspaces/orca-viz/wt-1.',
        result: '{"filesModified":["/home/dev/orca/workspaces/orca-viz/wt-1/src/a.ts"]}',
        status: 'completed',
        createdAt: at(0),
        completedAt: at(MINUTE),
      })
    );

    expect(byHandle(runs, ORCHESTRATOR).repoHint).toEqual({
      value: 'orca-viz',
      sources: ['task specs', 'task results'],
    });
  });

  it('refuses a run whose evidence names two projects', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: ORCHESTRATOR,
          spec: 'Work in /home/dev/orca/workspaces/orca-viz/wt-1.',
          createdAt: at(0),
        })
        .task({
          id: 'task_2',
          handle: ORCHESTRATOR,
          spec: 'Work in /home/dev/orca/workspaces/orchestrator/wt-2.',
          createdAt: at(MINUTE),
        })
    );

    expect('repoHint' in byHandle(runs, ORCHESTRATOR)).toBe(false);
  });

  it('refuses a run with no path evidence at all', async () => {
    const runs = await runsOf(
      new FixtureBuilder().task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'no paths here', createdAt: at(0) })
    );

    expect('repoHint' in byHandle(runs, ORCHESTRATOR)).toBe(false);
  });

  it('hints from an archived path — no filesystem check stands between evidence and hint', async () => {
    const runs = await runsOf(
      new FixtureBuilder().task({
        id: 'task_1',
        handle: ORCHESTRATOR,
        spec: 'Worked in /home/nobody/orca/workspaces/long-archived-project/wt-9 (since deleted).',
        createdAt: at(0),
      })
    );

    expect(byHandle(runs, ORCHESTRATOR).repoHint).toEqual({
      value: 'long-archived-project',
      sources: ['task specs'],
    });
  });

  it('scopes agreement to the run — another orchestrator’s project is not this one’s conflict', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({
          id: 'task_1',
          handle: ORCHESTRATOR,
          spec: 'Work in /home/dev/orca/workspaces/orca-viz/wt-1.',
          createdAt: at(0),
        })
        .task({
          id: 'task_2',
          handle: handleFor('other-orchestrator'),
          spec: 'Work in /home/dev/orca/workspaces/orchestrator/wt-2.',
          createdAt: at(MINUTE),
        })
    );

    expect(byHandle(runs, ORCHESTRATOR).repoHint).toEqual({ value: 'orca-viz', sources: ['task specs'] });
    expect(byHandle(runs, handleFor('other-orchestrator')).repoHint).toEqual({
      value: 'orchestrator',
      sources: ['task specs'],
    });
  });
});

describe('hints never touch identity', () => {
  it('leaves run ids, cast monograms and task attribution exactly as they were', async () => {
    const runs = await runsOf(
      new FixtureBuilder()
        .task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'You are a Claude Code agent.', createdAt: at(0) })
        .task({
          id: 'task_2',
          handle: ORCHESTRATOR,
          spec: 'You are a Codex agent, in /home/dev/orca/workspaces/orca-viz/wt-2.',
          createdAt: at(MINUTE),
        })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .dispatch({ taskId: 'task_2', assigneeHandle: BOB, dispatchedAt: at(2 * MINUTE) })
    );

    const run = byHandle(runs, ORCHESTRATOR);

    // The hint is a label riding beside identity, never identity (SPEC §12.4): the run is still
    // keyed on the handle alone, the cast is still numbered by first dispatch, and every task
    // still belongs to the member the dispatch rows say — whatever the evidence spells.
    expect(run.id).toBe(`run_${ORCHESTRATOR}`);
    expect(run.cast.map((m) => [m.monogram, m.handle, m.taskIds])).toEqual([
      ['A1', ALICE, ['task_1']],
      ['A2', BOB, ['task_2']],
    ]);
  });
});

describe('degradation', () => {
  it('disables hints by name only when every evidence column is gone', async () => {
    harness = await serve(
      new FixtureBuilder({
        omitColumns: { tasks: ['spec', 'result'], messages: ['payload'] },
      })
        .task({ id: 'task_1', handle: ORCHESTRATOR, createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .write(tempDbPath())
    );

    const { meta, snapshot } = await harness.snapshot();

    expect(meta.degraded.some((reason) => reason.startsWith('Agent-kind hints'))).toBe(true);
    expect(meta.degraded.some((reason) => reason.startsWith('Repository hints'))).toBe(true);
    // And the features degrade to honest absence, never to a throw or a guess.
    expect('kindHint' in member(byHandle(snapshot.runs, ORCHESTRATOR), ALICE)).toBe(false);
    expect('repoHint' in byHandle(snapshot.runs, ORCHESTRATOR)).toBe(false);
  });

  it('keeps hinting from the columns that remain — one lost source is fewer hints, not none', async () => {
    harness = await serve(
      new FixtureBuilder({ omitColumns: { tasks: ['result'], messages: ['payload'] } })
        .task({ id: 'task_1', handle: ORCHESTRATOR, spec: 'You are a Claude Code agent.', createdAt: at(0) })
        .dispatch({ taskId: 'task_1', assigneeHandle: ALICE, dispatchedAt: at(MINUTE) })
        .write(tempDbPath())
    );

    const { meta, snapshot } = await harness.snapshot();

    expect(meta.degraded.some((reason) => reason.startsWith('Agent-kind hints'))).toBe(false);
    expect(meta.degraded.some((reason) => reason.startsWith('Repository hints'))).toBe(false);
    expect(member(byHandle(snapshot.runs, ORCHESTRATOR), ALICE).kindHint).toEqual({
      value: 'claude',
      sources: ['spec'],
    });
  });
});

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.tsx';
import { type ArchiveRead, archiveHistory, archiveTaskLoader } from '../../src/client/archive.ts';
import { Replay } from '../../src/client/Replay.tsx';
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, ArchiveError, readArchive, type RunArchive } from '../../src/shared/archive.ts';
import type { Run, Task, Turn } from '../../src/shared/types.ts';

/**
 * **The archived replay** (#74, ADR 0001) — the same shell, reading a saved file.
 *
 * The presentation claims of the ticket are all *negative*, and each of them is a thing the live
 * screen says that this one may not:
 *
 * - it is **archived and offline**, and it makes no claim about now — no liveness pill, no green
 *   dot, no database path, and no stream to open;
 * - there is **nothing to export** from an export, and nothing to write anywhere;
 * - a **newer** archive still renders, under a warning, with the fields this build has never heard
 *   of preserved in the file and the receipts it cannot read shown exactly as they were written.
 *
 * And one positive: everything else is the ordinary selected-run presentation. The rail, the
 * canvas, the conversation and the inspector are the same components, reading the same evidence.
 */

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const AGENT = 'term_11112222-1234-4321-8888-aabbccddeeff';
const RUN = 'run_term_9f8e7d6c';
const OTHER_RUN = 'run_term_other';

const TASK: Task = {
  id: 'task_aaaaaaaa',
  runId: RUN,
  parentId: null,
  title: 'Read the spec',
  status: 'completed',
  deps: ['task_faraway'],
  createdAt: '2026-07-11T20:54:00.000Z',
  completedAt: '2026-07-11T21:00:00.000Z',
  hasSpec: true,
  hasResult: true,
  dispatch: null,
  attemptCount: 1,
  gate: null,
};

/** The far end of a dependency edge that leaves the run — in the file, but in another orchestrator. */
const LINKED: Task = { ...TASK, id: 'task_faraway', runId: OTHER_RUN, title: 'Somebody else’s task', deps: [] };

const RUN_SUMMARY: Run = {
  id: RUN,
  handle: HANDLE,
  label: 'Ship the visualizer',
  startedAt: '2026-07-11T20:54:00.000Z',
  endedAt: '2026-07-11T21:30:00.000Z',
  taskCount: 1,
  cast: [{ handle: AGENT, monogram: 'A1', taskIds: [TASK.id], taskCount: 1, lastHeartbeatAt: null }],
  waves: [{ index: 1, startedAt: '2026-07-11T20:54:00.000Z', endedAt: '2026-07-11T21:30:00.000Z', taskIds: [TASK.id], idleGapBeforeMs: null }],
  statusCounts: { pending: 0, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
  live: false,
  // The run health #81 derives on the client (SPEC §12.3). This fixture is a finished run — it
  // ended, and its one task completed — so it converged, and its last activity is that ending.
  converged: true,
  lastActivityAt: '2026-07-11T21:30:00.000Z',
  hasBlockingGates: false,
  edgeCount: 0,
};

const TURN: Turn = {
  id: 'msg:1',
  runId: RUN,
  direction: 'in',
  kind: 'worker_done',
  fromHandle: AGENT,
  toHandle: HANDLE,
  at: '2026-07-11T21:00:00.000Z',
  taskId: TASK.id,
  subject: 'Done',
  body: 'Shipped it.',
  source: 'messages',
};

/** A receipt shape nobody has ever seen — the raw evidence a replay must render verbatim. */
const UNKNOWN_RECEIPT = '{"outcome":{"invented":"later"},"files":["src/a.ts"]}';

function archive(over: Partial<RunArchive> = {}): RunArchive {
  return {
    provenance: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: '2026-07-12T09:30:00.000Z',
      tool: 'orca-viz 0.5.0',
      source: { schemaVersion: 5, schemaSupport: 'supported', degraded: [] },
      derivation: 'Retained evidence for one orchestrator run…',
    },
    run: RUN_SUMMARY,
    tasks: [TASK],
    attempts: {
      [TASK.id]: [
        {
          id: 'ctx_1',
          assigneeHandle: AGENT,
          status: 'completed',
          failureCount: 0,
          lastFailure: null,
          dispatchedAt: '2026-07-11T20:55:00.000Z',
          completedAt: '2026-07-11T21:00:00.000Z',
          lastHeartbeatAt: null,
        },
      ],
    },
    gates: [],
    turns: [TURN],
    linkedTasks: [LINKED],
    coordinatorRuns: [],
    bodies: { [TASK.id]: { spec: 'READ THE SPEC', result: UNKNOWN_RECEIPT } },
    messages: [
      {
        id: 'msg_1',
        sequence: 1,
        type: 'worker_done',
        fromHandle: AGENT,
        toHandle: HANDLE,
        subject: 'Done',
        body: 'Shipped it.',
        priority: 'normal',
        threadId: null,
        payload: { taskId: TASK.id, outcome: { invented: 'later' } },
        createdAt: '2026-07-11T21:00:00.000Z',
        taskId: TASK.id,
        runId: RUN,
      },
    ],
    ...over,
  };
}

function view(over: Partial<RunArchive> = {}, compatibility: ArchiveRead['compatibility'] = 'supported'): ArchiveRead {
  return { archive: archive(over), compatibility };
}

/** The replay shell, driven by an archive — exactly what `<Replay>` composes after its one fetch. */
function replay(archived: ArchiveRead = view()) {
  return render(
    <App
      event={null}
      archive={archived}
      loadHistory={archiveHistory(archived.archive)}
      loadTask={archiveTaskLoader(archived.archive)}
    />
  );
}

/** A node is clicked with `fireEvent`, never `user-event` — the d3-drag rule (inspector.test.tsx). */
async function openTask(): Promise<HTMLElement> {
  await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));
  fireEvent.click(screen.getAllByTestId('task-node')[0]!);
  return screen.getByTestId('inspector');
}

describe('an archived replay says what it is', () => {
  it('is archived and offline, and claims nothing about now', async () => {
    replay();

    const status = await screen.findByRole('status');
    expect(status.dataset.state).toBe('archived');
    expect(status.textContent).toMatch(/archived/i);
    expect(status.textContent).toMatch(/offline/i);
    // The instant the evidence was taken — and no claim that anything is running.
    expect(status.textContent).toMatch(/nothing is running/i);
    expect(status.textContent).not.toMatch(/connected to a running Orca|last-known state/i);
  });

  it('shows the run and the tool that exported it, and no database path', () => {
    replay();

    expect(screen.getByText('Ship the visualizer', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('orca-viz 0.5.0')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('orchestration.db');
    expect(screen.queryByText('Database')).not.toBeInTheDocument();
  });

  it('offers nothing to export — a replay *is* the export', () => {
    replay();

    expect(screen.queryByTestId('export-run')).not.toBeInTheDocument();
  });

  it('never opens a stream: the page that polls is a different bundle', async () => {
    const source = vi.fn();
    vi.stubGlobal('EventSource', source);

    // The whole replay page, from its one read of the file to the screen — and not one byte of
    // transport in between. A `<Live>` here would have constructed an `EventSource` on mount.
    render(<Replay load={() => Promise.resolve(view())} />);

    await waitFor(() => expect(screen.getByRole('status').dataset.state).toBe('archived'));
    expect(source).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('waits under archived wording — "connecting to the database" is a claim, even for one frame', async () => {
    // A file that has not landed yet. The live shell's splash says it is connecting to a database;
    // a replay has no database, and must not say so while it opens a file.
    render(<Replay load={() => new Promise(() => {})} />);

    expect(await screen.findByText(/Opening the archive/i)).toBeInTheDocument();
    expect(screen.queryByText(/Connecting to the database/i)).not.toBeInTheDocument();
  });

  it('says so on the screen when the archive cannot be read, rather than drawing an empty canvas', async () => {
    const refusal = new ArchiveError(
      "This archive's core cannot be read: its tasks is not a list.",
      'The file is truncated or was edited by hand — export the run again.'
    );

    render(<Replay load={() => Promise.reject(refusal)} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('core cannot be read');
    expect(alert).toHaveTextContent('export the run again');
    // An empty canvas would be a claim — "this run had nothing in it" — and nobody has verified it.
    expect(screen.queryByTestId('task-node')).not.toBeInTheDocument();
  });
});

describe('an archived replay is the ordinary selected-run presentation', () => {
  it('draws the run, its cast, its canvas and its conversation, out of the file', async () => {
    replay();

    // The rail: one run, and its cast under it.
    expect(await screen.findByTestId('run-row')).toHaveAttribute('data-run', RUN);
    expect(screen.getAllByText('A1').length).toBeGreaterThan(0);
    // The rail's health dot says finished, because an archive carries no liveness claim forward.
    // The claim is the same one this test always made; the vocabulary is #81's three-state health
    // (`active | silent | finished`, SPEC §12.3), which replaced the old boolean dot.
    expect(screen.getByTestId('health-dot').dataset.health).toBe('finished');
    // There is no older history in a file: one run, and no way to ask for more.
    expect(screen.queryByTestId('load-older')).not.toBeInTheDocument();

    // The canvas, and the conversation.
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));
    expect(screen.getByText('Shipped it.')).toBeInTheDocument();
  });

  it('opens a node’s whole story — the bodies and the attempts came in the file', async () => {
    replay();

    const inspector = await openTask();

    // The bodies arrive from the file rather than from `GET /api/task/:id` — but through the same
    // loader seam, so the panel is the same panel, right down to reading them on the click.
    expect(await within(inspector).findByText('READ THE SPEC')).toBeInTheDocument();
    // A receipt shape this build has never seen, rendered exactly as it was written.
    expect(within(inspector).getByText(UNKNOWN_RECEIPT)).toBeInTheDocument();
    expect(within(inspector).getAllByTestId('attempt')).toHaveLength(1);
  });

  it('names a dependency that left the run, and does not pretend it can open it', async () => {
    replay();

    const inspector = await openTask();
    const chip = within(inspector).getByTestId('dep-outside-archive');

    expect(chip).toHaveTextContent('Somebody else’s task');
    expect(chip).toHaveTextContent('not in this archive');
    // Named, not offered: there is no run in this file to open it in — and it is *not* "gone",
    // which is what the live shell says about a task a reset deleted.
    expect(chip.tagName).toBe('SPAN');
    expect(within(inspector).getByTestId('deps-in').textContent).not.toContain('gone');
  });
});

describe('a newer archive renders, under a warning', () => {
  it('warns that a later orca-viz wrote it, and shows what it can', async () => {
    replay(view({ provenance: { ...archive().provenance, version: ARCHIVE_VERSION + 1 } }, 'newer'));

    const warning = await screen.findByText(/newer orca-viz/i);
    expect(warning).toHaveTextContent(`archive format v${ARCHIVE_VERSION + 1}`);
    expect(warning).toHaveTextContent('upgrade orca-viz');

    // …and the evidence it *can* read is on screen, rather than the whole file being refused.
    await waitFor(() => expect(screen.getAllByTestId('task-node')).toHaveLength(1));
  });

  it('keeps the fields it has never heard of — the reader hands the document back verbatim', () => {
    const raw = { ...archive(), receipts: [{ kind: 'invented-later' }] };

    const { archive: read, compatibility } = readArchive(raw);

    expect(compatibility).toBe('supported');
    expect((read as unknown as { receipts: unknown }).receipts).toEqual([{ kind: 'invented-later' }]);
  });

  it('explains an absence the *source database* caused, months after the database is gone', async () => {
    const degraded = ['The result receipt — this Orca has no tasks.result column, so the inspector cannot show what a worker reported back.'];
    replay(
      view({
        provenance: {
          ...archive().provenance,
          source: { schemaVersion: 4, schemaSupport: 'older', degraded },
        },
      })
    );

    // The same sentence the live tool shows for the same fact (`schemaSentence`), and the same
    // list of what a missing column cost — recorded at export, because nothing else remembers it.
    expect(await screen.findByText(/older Orca schema/i)).toBeInTheDocument();
    expect(screen.getByText(degraded[0]!)).toBeInTheDocument();
    expect(screen.getByText(/source schema v4/i)).toBeInTheDocument();
  });

  it('warns when the *source database* was a newer Orca — where nothing is degraded by name', async () => {
    // The case a hand-written "these features are reduced" list would have missed entirely: a
    // newer Orca degrades nothing, and everything it added may still be missing or mislabeled.
    replay(
      view({
        provenance: {
          ...archive().provenance,
          source: { schemaVersion: 6, schemaSupport: 'newer', degraded: [] },
        },
      })
    );

    expect(await screen.findByText(/newer Orca schema/i)).toBeInTheDocument();
  });
});

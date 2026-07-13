import { describe, expect, it } from 'vitest';
import {
  ARCHIVE_FORMAT,
  ARCHIVE_VERSION,
  ArchiveError,
  archiveFilename,
  readArchive,
} from '../../src/shared/archive.ts';

/**
 * The archive **reader** — the pure half of #74, and the one with the dense error surface
 * (SPEC §14.5): what a file has to be before a replay of it is worth opening, what it may
 * contain that this build has never heard of, and what it may not.
 *
 * The rule under test is the last acceptance criterion of the ticket, and it has two sides that
 * must not be confused with each other:
 *
 * - **Unknown is fine.** A newer archive, a field this build does not know, a receipt shape
 *   nobody has ever seen: read, kept **verbatim**, and flagged so the screen can say so.
 * - **Unreadable is not.** A required core that will not parse fails *actionably* — by name, with
 *   what to do about it — rather than half-drawing a canvas out of a file that is not one.
 */

/** The smallest thing this build will open: one run, and the empty collections around it. */
function minimalArchive(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provenance: {
      format: ARCHIVE_FORMAT,
      version: ARCHIVE_VERSION,
      exportedAt: '2026-07-08T12:00:00.000Z',
      tool: 'orca-viz 0.5.0',
      source: { schemaVersion: 5, schemaSupport: 'supported', degraded: [] },
      derivation: 'Retained evidence for one orchestrator run…',
    },
    run: {
      id: 'run_term_a',
      handle: 'term_a',
      label: 'Ship the thing',
      startedAt: '2026-07-08T11:00:00.000Z',
      endedAt: '2026-07-08T11:30:00.000Z',
      taskCount: 1,
      cast: [],
      waves: [],
      statusCounts: { completed: 1 },
      live: false,
      hasOpenGates: false,
      edgeCount: 0,
    },
    tasks: [{ id: 'task_1', runId: 'run_term_a', status: 'completed', deps: [] }],
    attempts: {},
    gates: [],
    turns: [],
    linkedTasks: [],
    coordinatorRuns: [],
    bodies: { task_1: { spec: 'do it', result: 'done' } },
    messages: [],
    ...overrides,
  };
}

describe('readArchive — what this build will open', () => {
  it('reads an archive it wrote itself, and calls it supported', () => {
    const { archive, compatibility } = readArchive(minimalArchive());

    expect(compatibility).toBe('supported');
    expect(archive.run.id).toBe('run_term_a');
    expect(archive.bodies['task_1']).toEqual({ spec: 'do it', result: 'done' });
  });

  it('hands back the document verbatim — a field it has never heard of is still there', () => {
    const raw = minimalArchive({
      receipts: [{ kind: 'something-invented-later', files: ['src/a.ts'] }],
      messages: [{ id: 'msg_1', sequence: 1, type: 'worker_done', payload: { shape: { nobody: 'knows' } } }],
    });

    const { archive } = readArchive(raw);

    // The whole point of storing raw evidence beside the reading of it: a later orca-viz that
    // understands this receipt can still find it, because this one did not quietly delete it.
    expect((archive as unknown as { receipts: unknown[] }).receipts).toEqual([
      { kind: 'something-invented-later', files: ['src/a.ts'] },
    ]);
    expect(archive.messages[0]?.payload).toEqual({ shape: { nobody: 'knows' } });
  });

  it('reads a newer archive under a compatibility warning rather than refusing it', () => {
    const raw = minimalArchive();
    (raw.provenance as Record<string, unknown>).version = ARCHIVE_VERSION + 1;

    const { archive, compatibility } = readArchive(raw);

    expect(compatibility).toBe('newer');
    expect(archive.run.label).toBe('Ship the thing');
  });
});

describe('readArchive — what it refuses, and how', () => {
  function refusal(value: unknown): ArchiveError {
    try {
      readArchive(value);
    } catch (error) {
      expect(error).toBeInstanceOf(ArchiveError);
      return error as ArchiveError;
    }
    throw new Error('readArchive accepted a file it should have refused');
  }

  it('refuses a file that is not an archive at all, and says what one is', () => {
    for (const value of [null, 42, 'orchestration.db', [], { tasks: [] }]) {
      const error = refusal(value);
      expect(error.message).toContain('not an orca-viz run archive');
      expect(error.toString()).toContain('Export archive');
    }
  });

  it('refuses a file whose format is somebody else’s', () => {
    const raw = minimalArchive();
    (raw.provenance as Record<string, unknown>).format = 'some-other-tool.export';

    expect(refusal(raw).message).toContain(ARCHIVE_FORMAT);
  });

  it('refuses an archive with no readable format version', () => {
    for (const version of [undefined, '1', 0, 1.5]) {
      const raw = minimalArchive();
      (raw.provenance as Record<string, unknown>).version = version;

      const error = refusal(raw);
      expect(error.message).toContain('format version');
      expect(error.hint).toContain(`v${ARCHIVE_VERSION}`);
    }
  });

  it('refuses an archive whose provenance is half there — the bar reads it on sight', () => {
    // The archived/offline sentence, the tool and the source schema are dereferenced by the bar
    // and the notices the moment a replay renders. A file that got past the reader without them
    // would throw inside React — the white page the reader exists to make impossible.
    const raw = minimalArchive();
    delete (raw.provenance as Record<string, unknown>).exportedAt;
    delete ((raw.provenance as Record<string, unknown>).source as Record<string, unknown>).degraded;

    const error = refusal(raw);
    expect(error.message).toContain('provenance is missing exportedAt');
    expect(error.message).toContain('source.degraded');
  });

  it('refuses an archive with no source schema at all', () => {
    const raw = minimalArchive();
    delete (raw.provenance as Record<string, unknown>).source;

    expect(refusal(raw).message).toContain('provenance is missing source');
  });

  it('names every missing piece of the core at once, not just the first', () => {
    const error = refusal(minimalArchive({ tasks: undefined, turns: 'not a list' }));

    expect(error.message).toContain('tasks');
    expect(error.message).toContain('turns');
    // Actionable: the file is broken, and re-exporting is what fixes it.
    expect(error.hint).toContain('export the run again');
  });

  it('refuses an archive whose run has lost the fields the screen reads on sight', () => {
    const raw = minimalArchive();
    delete (raw.run as Record<string, unknown>).cast;
    delete (raw.run as Record<string, unknown>).label;

    const error = refusal(raw);
    expect(error.message).toContain('cast');
    expect(error.message).toContain('label');
  });

  it('refuses a task list holding something that is not a task, and says where', () => {
    const raw = minimalArchive({
      tasks: [{ id: 'task_1', runId: 'run_term_a', status: 'completed', deps: [] }, { id: 'task_2' }],
    });

    expect(refusal(raw).message).toContain('position 1');
  });

  it('fails a newer archive whose *core* it cannot read — and tells the user to upgrade', () => {
    const raw = minimalArchive({ tasks: undefined });
    (raw.provenance as Record<string, unknown>).version = ARCHIVE_VERSION + 1;

    const error = refusal(raw);
    expect(error.message).toContain('tasks');
    expect(error.hint).toContain('Upgrade orca-viz');
  });
});

describe('archiveFilename', () => {
  it('names the run and the instant, and nothing a filesystem could choke on', () => {
    expect(archiveFilename('run_term_1a2b', '2026-07-08T12:00:00.000Z')).toBe(
      'orca-viz-run_term_1a2b-2026-07-08T12-00-00-000Z.json'
    );
  });

  it('strips a run id that came out of somebody else’s database', () => {
    const name = archiveFilename('run_../../etc/passwd', '2026-07-08T12:00:00.000Z');

    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    // One `.` in the whole name, and it is the one before `json`.
    expect(name.split('.')).toHaveLength(2);
    expect(name).toMatch(/^orca-viz-run_-etc-passwd-.*\.json$/);
  });
});

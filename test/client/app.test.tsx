import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CannedApp, type CannedEvent } from './canned.tsx';
import type { Meta } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<CannedApp>` fed a canned world (`CannedEvent`, canned.tsx) — the stream event plus the
 * loaders' data, so this is the highest available frontend seam and it costs nothing new — and
 * the same fixtures feed both seams, so the contract cannot drift between them.
 *
 * What #14 owes the screen is **honesty about what is being read**. Every case below is a
 * sentence the user has to be told rather than left to infer — most of all the stale one,
 * which is the difference between reading history and being fooled by it.
 */

const META: Meta = {
  dbPath: '/home/dev/.config/orca/orchestration.db',
  schemaVersion: 5,
  schemaSupport: 'supported',
  degraded: [],
  liveness: 'live',
  orcaPid: 4242,
  dbMtime: '2026-07-11T20:54:00.000Z',
  historyLoss: [],
};

function event(meta: Partial<Meta> = {}): CannedEvent {
  return {
    seq: 0,
    affected: { all: true, runIds: [], unplaced: false },
    meta: { ...META, ...meta },
    snapshot: { runs: [], tasks: [], gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  };
}

describe('<CannedApp>', () => {
  it('tells you which database it is reading', () => {
    render(<CannedApp event={event()} />);

    expect(screen.getByText('/home/dev/.config/orca/orchestration.db')).toBeVisible();
  });

  it('says so when it is connected to a running Orca', () => {
    render(<CannedApp event={event({ liveness: 'live' })} />);

    expect(screen.getByText(/connected to a running Orca/i)).toBeVisible();
  });

  it("says Orca isn't running, and from when the data is, rather than pretending it is live", () => {
    render(<CannedApp event={event({ liveness: 'stale', orcaPid: null })} />);

    const banner = screen.getByText(/Orca isn't running; showing last-known state from/i);

    expect(banner).toBeVisible();
    expect(banner).toHaveTextContent(/2026/); // …from *when*. A time the user can place.
  });

  it('degrades an unknown liveness to the same honest stale wording', () => {
    // We could not read orca-runtime.json, so we do not know. Saying "live" would be a
    // guess, and this is the one thing the tool must never guess about.
    render(<CannedApp event={event({ liveness: 'unknown', orcaPid: null })} />);

    expect(screen.getByText(/Orca isn't running; showing last-known state from/i)).toBeVisible();
  });

  it('warns when the database comes from a newer Orca than this build knows about', () => {
    render(<CannedApp event={event({ schemaVersion: 6, schemaSupport: 'newer' })} />);

    expect(screen.getByText(/newer Orca schema/i)).toBeVisible();
    expect(screen.getByText(/some data may be missing or mislabeled/i)).toBeVisible();
  });

  it('lists what an older Orca cost you, so a missing badge is explained rather than a bug', () => {
    // Every feature, not the first one: this list *is* the explanation for an empty badge, and
    // a truncated one sends the user hunting for a bug that is really a missing column (#21).
    render(
      <CannedApp
        event={event({
          schemaVersion: 3,
          schemaSupport: 'older',
          degraded: [
            'Task titles — this Orca has no task_title/display_name column, so tasks are labelled by their short id.',
            'Runs — this Orca has no created_by_terminal_handle column, so every task lands in Unattributed.',
          ],
        })}
      />
    );

    expect(screen.getByText(/older Orca schema/i)).toBeVisible();
    expect(screen.getByText(/Task titles/)).toBeVisible();
    expect(screen.getByText(/Runs — this Orca has no created_by_terminal_handle/)).toBeVisible();
    expect(screen.getByText(/schema v3/)).toBeVisible();
  });

  it('explains a lost feature even when the version number is the one it was built for', () => {
    // The columns decide, not the version number (#21). An Orca that renamed a column — or
    // dropped a table — carries a `user_version` this build calls supported and is still
    // missing a feature. Gating the explanation on the *version* would leave exactly that
    // user staring at an empty badge with nothing on screen to explain it, which is the bug
    // `meta.degraded` exists to prevent.
    render(
      <CannedApp
        event={event({
          schemaSupport: 'supported',
          degraded: ['The "last seen" badge — this Orca has no last_heartbeat_at column, so agent liveness is not shown.'],
        })}
      />
    );

    expect(screen.getByText(/"last seen" badge/)).toBeVisible();
  });

  it('says nothing about degradation when an older Orca happens to cost you nothing', () => {
    // The version alone is not a problem — a missing *column* is. An older schema we read in
    // full has no feature to name, and a banner over an empty list would be furniture.
    render(<CannedApp event={event({ schemaVersion: 4, schemaSupport: 'older', degraded: [] })} />);

    expect(screen.queryByText(/older Orca schema/i)).toBeNull();
  });

  // The history-loss sentences are asserted as literals here and in `boot.test.ts`, so the
  // two surfaces are pinned to the same evidence-first words (SPEC §5.1) by the tests and
  // not merely by sharing `shared/wording.ts`.
  it('explains lost message history with the exact evidence-first sentence', () => {
    render(<CannedApp event={event({ historyLoss: ['message-history'] })} />);

    expect(
      screen.getByText(
        'Message history is incomplete: sequence gaps show that this database once held messages which are now missing. This matches an orchestration reset.'
      )
    ).toBeVisible();
  });

  it('explains lost task graph history with the exact evidence-first sentence', () => {
    render(<CannedApp event={event({ historyLoss: ['task-graph-history'] })} />);

    expect(
      screen.getByText(
        'Task graph history is missing: the graph is empty, but retained messages still refer to tasks. This matches `orchestration reset --tasks`.'
      )
    ).toBeVisible();
  });

  it('raises both full notices, message history first, when both loss shapes are present', () => {
    render(<CannedApp event={event({ historyLoss: ['message-history', 'task-graph-history'] })} />);

    const message = screen.getByText(
      'Message history is incomplete: sequence gaps show that this database once held messages which are now missing. This matches an orchestration reset.'
    );
    const graph = screen.getByText(
      'Task graph history is missing: the graph is empty, but retained messages still refer to tasks. This matches `orchestration reset --tasks`.'
    );

    expect(message).toBeVisible();
    expect(graph).toBeVisible();
    // The stable order (SPEC §5.1), on screen and not merely in the array.
    expect(message.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says nothing about lost history, schemas or staleness when there is nothing to say', () => {
    render(<CannedApp event={event()} />);

    expect(screen.queryByText(/reset/i)).toBeNull();
    expect(screen.queryByText(/history/i)).toBeNull();
    expect(screen.queryByText(/newer Orca schema/i)).toBeNull();
    expect(screen.queryByText(/isn't running/i)).toBeNull();
  });


  it('says it is connecting before the first snapshot arrives', () => {
    render(<CannedApp event={null} />);

    expect(screen.getByText(/connecting/i)).toBeVisible();
  });

  it('renders the stream presentation it is handed, apart from the liveness sentence (#57)', () => {
    // The transport can be down while Orca is very much alive — the two pills answer two
    // different questions, and the shell must be able to say both at once.
    render(<CannedApp event={event({ liveness: 'live' })} connection="reconnecting" />);

    const pill = screen.getByTestId('stream-state');
    expect(pill).toHaveAttribute('data-state', 'reconnecting');
    expect(pill).toHaveTextContent(/reconnecting/i);
    expect(screen.getByText(/connected to a running Orca/i)).toBeVisible();
  });

  it('shows how old the applied snapshot is when it was given an apply time (#57)', () => {
    render(<CannedApp event={event()} appliedAt={Date.now() - 125_000} />);

    expect(screen.getByTestId('data-age')).toHaveTextContent(/^2m$/);
  });

  it('claims no data age it was never handed (#57)', () => {
    // A canned event with no apply instant — the shell shows the data, and simply does not
    // invent a time it never observed.
    render(<CannedApp event={event()} />);

    expect(screen.queryByTestId('data-age')).toBeNull();
  });
});

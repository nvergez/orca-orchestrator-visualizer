import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/client/App.tsx';
import type { Meta, StreamEvent } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): `<App>` fed a canned `StreamEvent`. `StreamEvent` is already the client's
 * only input, so this is the highest available frontend seam and it costs nothing new — and
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
  resetDetected: false,
};

function event(meta: Partial<Meta> = {}): StreamEvent {
  return {
    seq: 0,
    affected: { all: true, runIds: [], unplaced: false },
    meta: { ...META, ...meta },
    snapshot: { runs: [], tasks: [], gates: [], turns: [], coordinatorRuns: [] },
    messages: [],
  };
}

describe('<App>', () => {
  it('tells you which database it is reading', () => {
    render(<App event={event()} />);

    expect(screen.getByText('/home/dev/.config/orca/orchestration.db')).toBeVisible();
  });

  it('says so when it is connected to a running Orca', () => {
    render(<App event={event({ liveness: 'live' })} />);

    expect(screen.getByText(/connected to a running Orca/i)).toBeVisible();
  });

  it("says Orca isn't running, and from when the data is, rather than pretending it is live", () => {
    render(<App event={event({ liveness: 'stale', orcaPid: null })} />);

    const banner = screen.getByText(/Orca isn't running; showing last-known state from/i);

    expect(banner).toBeVisible();
    expect(banner).toHaveTextContent(/2026/); // …from *when*. A time the user can place.
  });

  it('degrades an unknown liveness to the same honest stale wording', () => {
    // We could not read orca-runtime.json, so we do not know. Saying "live" would be a
    // guess, and this is the one thing the tool must never guess about.
    render(<App event={event({ liveness: 'unknown', orcaPid: null })} />);

    expect(screen.getByText(/Orca isn't running; showing last-known state from/i)).toBeVisible();
  });

  it('warns when the database comes from a newer Orca than this build knows about', () => {
    render(<App event={event({ schemaVersion: 6, schemaSupport: 'newer' })} />);

    expect(screen.getByText(/newer Orca schema/i)).toBeVisible();
    expect(screen.getByText(/some data may be missing or mislabeled/i)).toBeVisible();
  });

  it('lists what an older Orca cost you, so a missing badge is explained rather than a bug', () => {
    // Every feature, not the first one: this list *is* the explanation for an empty badge, and
    // a truncated one sends the user hunting for a bug that is really a missing column (#21).
    render(
      <App
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
      <App
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
    render(<App event={event({ schemaVersion: 4, schemaSupport: 'older', degraded: [] })} />);

    expect(screen.queryByText(/older Orca schema/i)).toBeNull();
  });

  it('explains a history that a reset wiped, rather than leaving it a mystery', () => {
    render(<App event={event({ resetDetected: true })} />);

    expect(screen.getByText(/reset/i)).toBeVisible();
  });

  it('says nothing about resets, schemas or staleness when there is nothing to say', () => {
    render(<App event={event()} />);

    expect(screen.queryByText(/reset/i)).toBeNull();
    expect(screen.queryByText(/newer Orca schema/i)).toBeNull();
    expect(screen.queryByText(/isn't running/i)).toBeNull();
  });


  it('says it is connecting before the first snapshot arrives', () => {
    render(<App event={null} />);

    expect(screen.getByText(/connecting/i)).toBeVisible();
  });
});

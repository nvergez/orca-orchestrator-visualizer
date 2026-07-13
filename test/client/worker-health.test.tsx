import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STALE_HEARTBEAT_MS } from '../../src/client/canvas/theme.ts';
import { useNow } from '../../src/client/relative-time.ts';
import { workerHealth } from '../../src/client/worker-health.ts';

const NOW = Date.parse('2026-07-12T20:00:00.000Z');

afterEach(() => vi.useRealTimers());

function Clock({ pushed }: { pushed: unknown }) {
  return <output data-testid="clock">{useNow(pushed)}</output>;
}

describe('the shared client clock', () => {
  it('advances every 30 seconds without a new pushed value', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    render(<Clock pushed={{ unchanged: true }} />);

    expect(screen.getByTestId('clock')).toHaveTextContent(String(NOW));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByTestId('clock')).toHaveTextContent(String(NOW + 30_000));
  });
});

describe('worker health', () => {
  it('distinguishes a new dispatch awaiting its first heartbeat from one that has gone stale', () => {
    expect(
      workerHealth({
        status: 'dispatched',
        dispatchedAt: new Date(NOW - 2 * 60_000).toISOString(),
        lastHeartbeatAt: null,
        now: NOW,
      })
    ).toMatchObject({ state: 'quiet', heartbeat: 'missing', elapsedMs: 2 * 60_000 });

    expect(
      workerHealth({
        status: 'dispatched',
        dispatchedAt: new Date(NOW - STALE_HEARTBEAT_MS - 1).toISOString(),
        lastHeartbeatAt: null,
        now: NOW,
      })
    ).toMatchObject({ state: 'stale', heartbeat: 'missing', elapsedMs: STALE_HEARTBEAT_MS + 1 });
  });

  it('uses a heartbeat as the latest evidence of activity and ignores settled attempts', () => {
    expect(
      workerHealth({
        status: 'dispatched',
        dispatchedAt: new Date(NOW - 20 * 60_000).toISOString(),
        lastHeartbeatAt: new Date(NOW - 30_000).toISOString(),
        now: NOW,
      })
    ).toMatchObject({ state: 'working', heartbeat: 'received', elapsedMs: 30_000 });

    expect(
      workerHealth({
        status: 'completed',
        dispatchedAt: new Date(NOW - 20 * 60_000).toISOString(),
        lastHeartbeatAt: new Date(NOW - 30_000).toISOString(),
        now: NOW,
      })
    ).toEqual({ state: 'inactive' });
  });
});

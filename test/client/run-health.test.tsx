import { describe, expect, it } from 'vitest';
import { runHealth, STALE_HEARTBEAT_MS } from '../../src/shared/run-health.ts';

/**
 * The one pure derivation behind every run-health presentation (SPEC §12.3). It is a wire-level
 * contract, not a component: the server projects the deprecated `live` through it at snapshot
 * time, and the rail derives the dot from it against the shared wall clock — so its boundaries
 * are asserted here once, where both consumers can be held to the same answer.
 *
 * It lives in the client suite — health is the *client's* derivation (SPEC §12.3), the server
 * only borrows it — and it is a `.tsx` with no JSX because that is the client project's include
 * pattern (`vitest.config.ts`).
 */

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const TEN_MINUTES = 10 * 60 * 1000;

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

describe('runHealth', () => {
  it('calls a converged run finished, however recent its last activity', () => {
    // A run that just wrapped up has activity seconds old. Recency must not outvote
    // convergence: finished is a fact about task outcomes, not about the clock (SPEC §12.3).
    expect(runHealth({ converged: true, lastActivityAt: ago(5_000) }, NOW)).toBe('finished');
  });

  it('calls a converged run finished even when its activity is unreadable', () => {
    expect(runHealth({ converged: true, lastActivityAt: 'not a timestamp' }, NOW)).toBe('finished');
  });

  it('calls an unfinished run with recent activity active', () => {
    expect(runHealth({ converged: false, lastActivityAt: ago(5_000) }, NOW)).toBe('active');
  });

  it('stays active up to — but not at — the ten-minute boundary', () => {
    // The boundary is exact (SPEC §12.3): one millisecond short is active, ten minutes on the
    // dot is silent. "At least ten minutes old" includes the boundary itself.
    expect(runHealth({ converged: false, lastActivityAt: ago(TEN_MINUTES - 1) }, NOW)).toBe('active');
    expect(runHealth({ converged: false, lastActivityAt: ago(TEN_MINUTES) }, NOW)).toBe('silent');
  });

  it('calls an unfinished run with old activity silent', () => {
    expect(runHealth({ converged: false, lastActivityAt: ago(4 * 60 * 60 * 1000) }, NOW)).toBe('silent');
  });

  it('calls an unfinished run whose activity nobody can read silent', () => {
    // An unreadable instant is not the epoch and not "just now" — it is no evidence of recent
    // activity at all, and silent is the state that claims nothing (SPEC §12.3).
    expect(runHealth({ converged: false, lastActivityAt: 'not a timestamp' }, NOW)).toBe('silent');
    expect(runHealth({ converged: false, lastActivityAt: '' }, NOW)).toBe('silent');
  });

  it('clamps future evidence to age zero, so clock skew cannot invent a fourth state', () => {
    expect(runHealth({ converged: false, lastActivityAt: ago(-90_000) }, NOW)).toBe('active');
  });

  it('shares the canonical ten-minute recency threshold — never a second run-only one', () => {
    // #47's worker-health constant and this one must be the same value (SPEC §12.3).
    expect(STALE_HEARTBEAT_MS).toBe(TEN_MINUTES);
  });
});

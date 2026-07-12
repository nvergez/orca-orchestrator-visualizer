import { useEffect, useState } from 'react';
import type { DurationClock, DurationObservation } from '../shared/types.ts';

/**
 * Honest durations, rendered (#66). The server sends a `DurationObservation` — a clock, its
 * endpoints, and never an invented number (`server/durations.ts`) — and this module is the one
 * place those observations become words, so the rail and the inspector cannot read the same
 * span as two different numbers.
 *
 * The wording *is* the provenance (SPEC §12.4):
 *
 * - a **dispatch** duration is a bare number — the preferred clock needs no qualifier;
 * - the **task-span** fallback says "task span" in the text itself, because a broader clock
 *   passed off as dispatch time is exactly the lie story 3 exists to prevent;
 * - an **open** interval says "so far", ages against the reader's own wall clock — advancing
 *   without waiting for an SSE push — and stops the moment a push carries the completion
 *   evidence, because a completed observation no longer reads the clock at all;
 * - the tooltip carries the rest: which columns, which instants, in the reader's timezone.
 */

/** What the reader's clock is re-read at while an open interval is on screen. */
const WALL_CLOCK_TICK_MS = 1000;

/** How each clock is named in the tooltip — the provenance, spelled out (SPEC §12.4). */
const CLOCK_NAMES: Record<DurationClock, string> = {
  dispatch: 'dispatch clock — dispatched → completed, from one attempt’s own row',
  'task-span': 'task span — created → completed; no completed dispatch clock was retained',
  'run-span': 'run span — earliest task creation → latest retained activity',
};

/**
 * "45s", "3m 20s", "2h 5m", "1d 2h" — two units at most. A post-mortem compares attempts; it
 * does not audit seconds inside hours, and the exact instants are in the tooltip. Never
 * negative: the server refuses backwards clocks, so anything below zero here is client clock
 * skew on an open interval, and it reads as a start, not a debt.
 */
export function formatDurationMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return withRest(minutes, 'm', seconds % 60, 's');

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return withRest(hours, 'h', minutes % 60, 'm');

  return withRest(Math.floor(hours / 24), 'd', hours % 24, 'h');
}

function withRest(major: number, majorUnit: string, rest: number, restUnit: string): string {
  return rest === 0 ? `${major}${majorUnit}` : `${major}${majorUnit} ${rest}${restUnit}`;
}

/** An observation on screen: the words, and the provenance the tooltip owes beside them. */
export type DurationReading = { text: string; title: string };

/**
 * The words for one observation — or **null when there are none**, which the caller renders as
 * nothing at all. The server only sends readable endpoints, so null here is defence, not policy:
 * a wire this client did not expect must fall silent rather than say "NaN ago".
 */
export function readDuration(observation: DurationObservation, now: number): DurationReading | null {
  const clock = CLOCK_NAMES[observation.clock as DurationClock] ?? observation.clock;

  if (!observation.complete) {
    const start = Date.parse(observation.startAt);
    if (Number.isNaN(start)) return null;

    return {
      text: `${formatDurationMs(now - start)} so far`,
      title: `${clock} — started ${local(observation.startAt)}, not finished per retained evidence; measured against your clock`,
    };
  }

  // `ms` must agree with the endpoints it rides with (the server derives it from them), and is
  // optional on the wire — so the endpoints are the fallback, never a second opinion.
  const ms = observation.ms ?? spanOf(observation);
  if (ms === null) return null;

  const label = observation.clock === 'task-span' ? `${formatDurationMs(ms)} task span` : formatDurationMs(ms);
  return { text: label, title: `${clock} · ${local(observation.startAt)} → ${local(observation.endAt ?? '')}` };
}

function spanOf({ startAt, endAt }: DurationObservation): number | null {
  const start = Date.parse(startAt);
  const end = Date.parse(endAt ?? '');
  return Number.isNaN(start) || Number.isNaN(end) ? null : end - start;
}

/** The exact instant, in the reader's own timezone — the same rendering `ageOf` gives one. */
function local(iso: string): string {
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : new Date(at).toLocaleString();
}

/**
 * The reader's clock, re-read every second — but **only while something open is on screen**.
 * A completed observation never subscribes, so a page full of finished runs holds perfectly
 * still (SPEC §7.9) and schedules nothing. The initializer covers the first paint; the first
 * interval tick is at most a second behind it, which is as stale as this clock ever gets.
 */
function useWallClock(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!ticking) return undefined;

    const clock = setInterval(() => setNow(Date.now()), WALL_CLOCK_TICK_MS);
    return () => clearInterval(clock);
  }, [ticking]);

  return now;
}

/**
 * One observation, worded and aged. Open intervals tick on their own (`useWallClock`); a
 * completed one reads its number off the wire and never looks at the clock again — which is
 * what "stops when completion evidence arrives" means mechanically: the next push replaces the
 * observation, `complete` flips, and the interval unsubscribes.
 */
export function Duration({
  observation,
  testId,
  className,
}: {
  observation: DurationObservation;
  testId?: string;
  className?: string;
}) {
  const now = useWallClock(!observation.complete);
  const reading = readDuration(observation, now);
  if (reading === null) return null;

  return (
    <span data-testid={testId} title={reading.title} className={className}>
      {reading.text}
    </span>
  );
}

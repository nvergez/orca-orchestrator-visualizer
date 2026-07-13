import { RadarDot } from '@/components/fx/radar-dot';
import { cn } from '@/lib/utils';
import type { RunHealth } from '../shared/run-health.ts';

/**
 * **How a run stands, worn as a dot** — the rail's row wears it, and so does the kiosk's tile
 * (#62), which is why it is here rather than in either of them.
 *
 * The three looks live in one table so a state cannot pulse one thing, wear another and say a
 * third. Only `active` moves — the page's one "this is not finished" gesture (SPEC §7.9).
 * `silent` holds still in amber over work that has not converged; `finished` holds still in the
 * muted grey of a story that is over.
 *
 * The words are the glossary's (CONTEXT.md), and nobody else's: a silent run is *not* "ended",
 * "dead" or "stuck" — the model reports retained evidence, and those three are diagnoses the
 * database cannot support (SPEC §12.3). A wall display is precisely where that discipline would
 * be lost first — "silent" is a tempting word to sharpen when it is ten feet away and red would
 * carry — so the wall and the rail say it with the same table, and neither can sharpen it alone.
 */
export const HEALTH_WORDS: Record<RunHealth, string> = {
  active: 'active — recent activity',
  silent: 'silent — unfinished, no recent activity',
  finished: 'finished',
};

const HEALTH_LOOK: Record<RunHealth, { pulses: boolean; dot: string | false }> = {
  active: { pulses: true, dot: false },
  silent: { pulses: false, dot: 'bg-run-silent/70' },
  finished: { pulses: false, dot: false },
};

/**
 * A run's health, with an sr-only twin saying it in words — because a colour a screen reader
 * cannot reach was never said at all.
 *
 * `announce` is how a caller says *I have already said this in words*. The rail row is a dot and
 * nothing else, so there the dot has to speak. The kiosk tile writes the health out in full
 * beside it — with the length of the silence, which the dot cannot carry — and a dot that also
 * announced would have a screen reader say "silent" twice about the same run. The twin still
 * renders either way: it is where the health is *written down* for anything reading the DOM, and
 * a state that appeared only as a colour would be a state the tests could not see either.
 */
export function HealthDot({
  health,
  className,
  announce = true,
}: {
  health: RunHealth;
  className?: string;
  /** False ⇒ the caller says the health in words itself, and the dot goes quiet. */
  announce?: boolean;
}) {
  const look = HEALTH_LOOK[health];

  return (
    <>
      <RadarDot
        live={look.pulses}
        className={cn(className, look.dot)}
        // Not `aria-hidden`, unlike the shell's: on a row where nothing else says it, this dot
        // *is* the answer to "how does this run stand", and the twin below is how it reaches
        // everyone.
      />
      <span data-testid="health-dot" data-health={health} aria-hidden={!announce} className="sr-only">
        {HEALTH_WORDS[health]}
      </span>
    </>
  );
}

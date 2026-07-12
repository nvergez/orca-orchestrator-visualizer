import type { Node, NodeProps } from '@xyflow/react';
import { motion } from 'motion/react';
import type { Wave } from '../../shared/types.ts';
import { enter, EASE } from '../motion.ts';

/**
 * **A wave — the six-hour rule, finally visible** (SPEC §4.3, §7.5).
 *
 * A terminal that goes quiet for more than six hours and then dispatches again did two separate
 * bursts of work. The tool has always known this and always acted on it *silently*: the rule ended
 * a "run" and started another, so one orchestrator became several unrelated rows in the rail and
 * nothing on screen ever said why. The user saw only the consequences of a boundary they were
 * never shown.
 *
 * So the boundary is drawn. It is a dashed region behind the nodes of one burst, captioned with
 * the gap that opened it — *"Wave 2 · after 14h idle"*. The rule did not change; the same six
 * hours cut the same places. What changed is that the tool now **shows** the gap instead of
 * **imposing** it, and one orchestrator stays one row.
 *
 * Dashed and not solid, and behind everything rather than around it: this is a region of the
 * field, not a container the tasks are inside. The only hard edges on this canvas are still the
 * two that mean something — the selection outline, and the turning ring of a node with an agent in
 * it (SPEC §7.9).
 */

export type WaveNodeData = { wave: Wave; caption: string };
export type WaveFlowNode = Node<WaveNodeData, 'wave'>;

export function WaveRegion({ data }: NodeProps<WaveFlowNode>) {
  const { wave, caption } = data;

  return (
    <motion.div
      data-testid="wave-region"
      data-wave={wave.index}
      initial={enter({ opacity: 0 })}
      animate={{ opacity: 1 }}
      transition={EASE}
      // `pointer-events-none` is what keeps it a *backdrop*: a region the size of a third of the
      // canvas would otherwise swallow every click meant for the nodes standing on it.
      className="border-panel-border pointer-events-none size-full rounded-2xl border border-dashed"
    >
      <span className="bg-field text-muted-foreground absolute -top-2.5 left-4 flex items-center gap-1.5 rounded-full px-2 text-[10.5px] whitespace-nowrap">
        <b className="text-foreground font-semibold">Wave {wave.index}</b>
        {caption}
        {/* The gap itself, in the amber of work-in-flight's *absence*: the number that used to
            silently cut this orchestrator in two, said out loud. */}
        {wave.idleGapBeforeMs !== null && (
          <span
            data-testid="wave-gap"
            className="bg-status-dispatched-soft text-status-dispatched-ink rounded-full px-1.5 py-px font-medium"
          >
            after {idleFor(wave.idleGapBeforeMs)} idle
          </span>
        )}
      </span>
    </motion.div>
  );
}

/**
 * "14h", "2d" — the silence, coarsely. It is only ever *more than six hours*, so seconds and
 * minutes have nothing to say here, and a wave that opened after "14 h 12 min" of quiet is a wave
 * that opened after 14 hours.
 */
function idleFor(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

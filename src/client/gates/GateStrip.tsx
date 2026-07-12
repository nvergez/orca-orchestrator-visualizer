import type { Gate, Task } from '../../shared/types.ts';
import { GATE_COLOR } from '../canvas/theme.ts';

/**
 * The decision blocking your orchestration, above the canvas, in your way.
 *
 * It is the one panel in this tool that is allowed to **interrupt**, and everything about it
 * follows from that (SPEC §7.4):
 *
 * - **It appears only when the selected run has an open gate.** Nothing blocked, nothing on
 *   screen — a strip that is always there is furniture, and furniture stops being read. This is
 *   why it is not a tab: a tab you forget to open is exactly what a blocking question must not
 *   be behind.
 * - **It shows the question, the options, and the task it blocks**, and clicking it selects
 *   that task — straight from the question to the context that raised it.
 * - **A gate that names no task still appears.** 32 of the 53 gate messages in the live
 *   database carry no `payload.taskId`: they block the *run*, they mark no node, and there is
 *   nothing to click through to. Hiding them would hide the majority of every real blocker.
 * - **It never offers to answer.** This tool does not write to the database — not a gate
 *   resolution, not anything (SPEC §1.2). It shows you the question; you go and answer it in
 *   Orca.
 *
 * The gates arrive already derived, already scoped to the run and already open: the server owns
 * all of that (`server/gates.ts`), because a client that re-derived which questions were still
 * unanswered would be a second implementation of the ticket's whole trap.
 */

export type GateStripProps = {
  /** The selected run's **open** gates, oldest first. Empty ⇒ nothing renders at all. */
  gates: Gate[];
  /** The selected run's tasks — a gate names a task id, and a person needs its title. */
  tasks: Task[];
  /** Clicking a gate goes to the task it blocks, which centres the node and filters the feed. */
  onSelectTask: (taskId: string) => void;
};

export function GateStrip({ gates, tasks, onSelectTask }: GateStripProps) {
  if (gates.length === 0) return null;

  const titleOf = (taskId: string): string => tasks.find((task) => task.id === taskId)?.title ?? taskId;

  return (
    <section
      data-testid="gate-strip"
      // A status, not an alert: it is important, and it is not an emergency. An assertive live
      // region would interrupt a screen reader mid-sentence every time a run got blocked.
      role="status"
      aria-label={`${gates.length} open decision ${gates.length === 1 ? 'gate' : 'gates'}`}
      style={{
        flexShrink: 0,
        borderBottom: `1px solid ${GATE_COLOR.border}`,
        background: GATE_COLOR.bg,
        color: GATE_COLOR.text,
        padding: '8px 12px',
        // Several open gates in one run is a real shape (13 open across the live database), and
        // an unbounded strip would eat the canvas it is supposed to be pointing at.
        maxHeight: 160,
        overflowY: 'auto',
      }}
    >
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {gates.map((gate) => (
          <li key={gate.id} data-testid="gate">
            {gate.taskId === null ? (
              <GateEntry gate={gate} blocks={null} />
            ) : (
              <button
                type="button"
                onClick={() => onSelectTask(gate.taskId!)}
                style={{ display: 'block', width: '100%', textAlign: 'left', border: 'none', background: 'none', padding: 0, font: 'inherit', color: 'inherit', cursor: 'pointer' }}
              >
                <GateEntry gate={gate} blocks={titleOf(gate.taskId)} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One question. `blocks` is the *title* of the task it is holding up — or null, which is a fact
 * about the gate and not a gap in the data, and is said out loud rather than left blank.
 */
function GateEntry({ gate, blocks }: { gate: Gate; blocks: string | null }) {
  return (
    <span style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', fontSize: 13 }}>
      <span aria-hidden>⛔</span>

      {/*
        Clamped, and not because a question is unimportant — because on the real database a
        question is often several paragraphs of an agent explaining itself, and an unclamped
        strip would swallow the canvas it exists to point at. The whole of it is one hover away,
        and the message that raised it is in the feed, in full, where a body belongs.
      */}
      <b
        title={gate.question}
        style={{
          flex: '1 1 240px',
          minWidth: 0,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          whiteSpace: 'pre-line',
          lineHeight: 1.35,
        }}
      >
        {gate.question}
      </b>

      {gate.options.map((option) => (
        <span
          key={option}
          style={{
            padding: '1px 7px',
            borderRadius: 999,
            border: `1px solid ${GATE_COLOR.border}`,
            background: '#ffffff',
            fontSize: 11,
          }}
        >
          {option}
        </span>
      ))}

      <span style={{ fontSize: 11, opacity: 0.85 }}>
        {blocks === null ? 'blocks this run — no task named' : `blocks ${blocks}`}
      </span>
    </span>
  );
}

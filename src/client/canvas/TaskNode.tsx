import { Handle, type NodeProps, Position, type Node } from '@xyflow/react';
import { shortHandle } from '../../shared/handles.ts';
import type { Task } from '../../shared/types.ts';
import type { Pulse } from '../feed/theme.ts';
import { relativeTime } from '../relative-time.ts';
import { colorOf, GATE_COLOR, NODE_HEIGHT, NODE_WIDTH, SELECTED_OUTLINE, STALE_HEARTBEAT_MS } from './theme.ts';

/**
 * A task, as it appears on the canvas — the node component the dev approved on screen
 * (`prototype/src/TaskNode.jsx`), wired to the real `Task` contract.
 *
 * Everything it has to say, it says without being hovered: scanning a finished run for the
 * failed node must not require interaction (SPEC §7.5).
 *
 * Two of the things it says come from the feed rather than from the task row, and they are
 * both #18's half of the bidirectional link: the node the feed sent you to is **outlined**,
 * and a node something has just *happened* to **pulses** in the colour of the message that
 * happened (`feed/theme.ts`). The node knows neither which message nor why — it is handed a
 * colour, which is what keeps the canvas ignorant of the feed.
 */

export type TaskNodeData = {
  task: Task;
  now: number;
  /** The task the feed row pointed at, or the one you clicked. Outlined, and centred by the canvas. */
  selected: boolean;
  /** A message about this task just arrived. ~1 s, in its type's colour. Never a heartbeat. */
  pulse: Pulse | null;
};
export type TaskFlowNode = Node<TaskNodeData, 'task'>;

export function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, now, selected, pulse } = data;
  const color = colorOf(task.status);

  return (
    <div
      data-testid="task-node"
      data-task={task.id}
      data-selected={selected}
      // The *type*, not the colour: a test asserts that a `worker_done` flashed this node and
      // that a heartbeat never did, and neither of those is a question about a hex code.
      data-pulse={pulse?.type}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        boxSizing: 'border-box',
        background: color.bg,
        border: `1.5px solid ${color.border}`,
        borderLeft: `5px solid ${color.border}`,
        borderRadius: 6,
        padding: '5px 8px',
        fontSize: 11,
        color: color.text,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        cursor: 'pointer',
        // Selection is an *outline*, never the border: the border is the status, and a node
        // that changed colour when you clicked it would be a node that lied about its state.
        outline: selected ? `2px solid ${SELECTED_OUTLINE}` : undefined,
        outlineOffset: 2,
        ...(pulse && {
          boxShadow: `0 0 0 3px ${pulse.color}`,
          // The keyframes are in `index.html` — the one rule inline styles cannot express.
          animation: 'orca-pulse 1s ease-out',
          ['--orca-pulse' as string]: pulse.color,
        }),
      }}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0.4 }} />

      <div style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10 }}>
        <span
          aria-hidden
          style={{ width: 8, height: 8, borderRadius: 999, background: color.border, flexShrink: 0 }}
        />
        {/* The raw string, whatever it is: an unknown status names a real state (SPEC §5). */}
        <b>{task.status}</b>
        <GateMarker task={task} />
        <RetryMarker attemptCount={task.attemptCount} />
        <Assignee task={task} />
      </div>

      <div
        style={{
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          lineHeight: 1.25,
        }}
      >
        {task.title}
      </div>

      <LastSeen task={task} now={now} />

      <Handle type="source" position={Position.Bottom} style={{ opacity: 0.4 }} />
    </div>
  );
}

/**
 * ⛔ — this task is not working, it is *waiting on you* (SPEC §7.5).
 *
 * Only while the gate is open: an answered question is history, and history belongs in the
 * inspector, not as a warning on a node that is getting on with its work. The gate the server
 * hands the node is already the right one — the open one, when the task has several.
 *
 * The status colour underneath it stays whatever the row says. A `dispatched` task with an open
 * gate is still dispatched; the marker adds the reason it is not moving, and repainting the node
 * would be inventing a status Orca never wrote.
 */
function GateMarker({ task }: { task: Task }) {
  if (task.gate?.status !== 'open') return null;

  return (
    <span
      data-testid="gate-marker"
      title={task.gate.question}
      style={{ color: GATE_COLOR.text, fontWeight: 700, whiteSpace: 'nowrap' }}
    >
      ⛔ gate
    </span>
  );
}

/**
 * The **only** visible sign, anywhere, that a task was retried — nothing else in the schema
 * records it, and a silent re-dispatch would otherwise look like a first attempt. No task
 * has retried in real data yet, so this has to be right the first time one does.
 */
function RetryMarker({ attemptCount }: { attemptCount: number }) {
  if (attemptCount <= 1) return null;

  return (
    <span
      data-testid="retry-marker"
      title={`${attemptCount} dispatch attempts`}
      style={{ color: '#b45309', fontWeight: 700 }}
    >
      ↻{attemptCount}
    </span>
  );
}

/** Who has it, and how close they are to the circuit breaker (it trips at 3). */
function Assignee({ task }: { task: Task }) {
  if (!task.dispatch?.assigneeHandle) return null;
  const { assigneeHandle, failureCount } = task.dispatch;

  return (
    <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, alignItems: 'center' }}>
      {failureCount > 0 && (
        <span data-testid="failure-count" style={{ color: '#b91c1c', fontWeight: 700 }}>
          ✗{failureCount}
        </span>
      )}
      <span
        data-testid="assignee"
        title={assigneeHandle}
        style={{
          background: '#1e293b',
          color: '#e2e8f0',
          borderRadius: 4,
          padding: '1px 5px',
          fontFamily: 'ui-monospace, monospace',
        }}
      >
        {shortHandle(assigneeHandle)}
      </span>
    </span>
  );
}

/**
 * "last seen 12s ago" — a working agent told from a hung one (#12, story 7).
 *
 * Shown only while **the dispatch** is `dispatched` (SPEC §7.5) — not while the *task* is.
 * The two come apart on real rows: a task can still read `dispatched` while its latest
 * attempt has already `failed` or tripped the breaker, and an amber "last seen 3h ago" there
 * would report a hung agent where the schema plainly says a burned attempt. On a completed
 * dispatch the last heartbeat is just the moment the work stopped, and a badge would cry
 * wolf about a run that finished perfectly well.
 */
function LastSeen({ task, now }: { task: Task; now: number }) {
  const dispatch = task.dispatch;
  if (dispatch?.status !== 'dispatched' || !dispatch.lastHeartbeatAt) return null;

  const silentFor = now - Date.parse(dispatch.lastHeartbeatAt);
  if (Number.isNaN(silentFor)) return null;

  const stale = silentFor > STALE_HEARTBEAT_MS;

  return (
    <span
      data-testid="last-seen"
      data-stale={stale}
      style={{ fontSize: 9, color: stale ? '#b45309' : 'inherit', fontWeight: stale ? 700 : 400 }}
    >
      last seen {relativeTime(silentFor)} ago
    </span>
  );
}

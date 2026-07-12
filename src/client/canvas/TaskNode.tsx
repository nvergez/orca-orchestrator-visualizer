import { Handle, type NodeProps, Position, type Node } from '@xyflow/react';
import type { Task } from '../../shared/types.ts';
import {
  colorOf,
  isKnownStatus,
  NODE_HEIGHT,
  NODE_WIDTH,
  shortHandle,
  STALE_HEARTBEAT_MS,
} from './graph.ts';

/**
 * A task, as it appears on the canvas — the node component the dev approved on screen
 * (`prototype/src/TaskNode.jsx`), wired to the real `Task` contract.
 *
 * Everything it has to say, it says without being hovered: scanning a finished run for the
 * failed node must not require interaction (SPEC §7.5).
 */

export type TaskNodeData = { task: Task; now: number };
export type TaskFlowNode = Node<TaskNodeData, 'task'>;

export function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const { task, now } = data;
  const color = colorOf(task.status);

  return (
    <div
      data-testid="task-node"
      data-task={task.id}
      data-status={task.status}
      data-known-status={isKnownStatus(task.status)}
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
 * Only while the task is dispatched: on a completed task the last heartbeat is just the
 * moment the work stopped, and an amber badge there would cry wolf about a finished run.
 */
function LastSeen({ task, now }: { task: Task; now: number }) {
  const lastHeartbeatAt = task.dispatch?.lastHeartbeatAt;
  if (task.status !== 'dispatched' || !lastHeartbeatAt) return null;

  const silentFor = now - Date.parse(lastHeartbeatAt);
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

/** Coarse on purpose: the badge answers "is it still there", not "exactly when". */
function relativeTime(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

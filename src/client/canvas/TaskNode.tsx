import { Handle, type NodeProps, Position, type Node } from '@xyflow/react';
import { OctagonAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { Task } from '../../shared/types.ts';
import type { Pulse } from '../feed/theme.ts';
import { relativeTime } from '../relative-time.ts';
import { GATE_THEME, NODE_HEIGHT, NODE_WIDTH, SELECTED_RING, STALE_HEARTBEAT_MS, themeOf } from './theme.ts';

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
  const theme = themeOf(task.status);

  return (
    <div
      data-testid="task-node"
      data-task={task.id}
      data-selected={selected}
      // The *type*, not the colour: a test asserts that a `worker_done` flashed this node and
      // that a heartbeat never did, and neither of those is a question about a colour.
      data-pulse={pulse?.type}
      className={cn(
        'flex cursor-pointer flex-col gap-1 rounded-lg border border-l-4 px-2.5 py-2 text-[11px] shadow-sm transition-shadow hover:shadow-md',
        theme.surface,
        // Selection is an *outline*, never the border: the border is the status, and a node
        // that changed colour when you clicked it would be a node that lied about its state.
        selected && SELECTED_RING
      )}
      style={{
        // The one thing here that is a *number* and not a look: elkjs placed every node in the
        // graph against exactly these (`layout.ts`), so they cannot become a class.
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        ...(pulse && {
          boxShadow: `0 0 0 3px ${pulse.color}`,
          // The keyframes are in `index.css` — the one rule a style attribute cannot express.
          animation: 'orca-pulse 1s ease-out',
          ['--orca-pulse' as string]: pulse.color,
        }),
      }}
    >
      <Handle type="target" position={Position.Top} className="!size-1.5 !border-0 opacity-40" />

      <div className="flex items-center gap-1.5 text-[10px]">
        <span aria-hidden className={cn('size-2 shrink-0 rounded-full', theme.dot)} />
        {/* The raw string, whatever it is: an unknown status names a real state (SPEC §5). */}
        <b className="font-semibold tracking-tight">{task.status}</b>
        <GateMarker task={task} />
        <RetryMarker attemptCount={task.attemptCount} />
        <Assignee task={task} />
      </div>

      <div className="line-clamp-3 leading-tight font-medium">{task.title}</div>

      <LastSeen task={task} now={now} />

      <Handle type="source" position={Position.Bottom} className="!size-1.5 !border-0 opacity-40" />
    </div>
  );
}

/**
 * The octagon — this task is not working, it is *waiting on you* (SPEC §7.5).
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
    <Badge
      data-testid="gate-marker"
      variant="outline"
      title={task.gate.question}
      // A badge, like the assignee chip beside it (SPEC §7.5) — not bare text. It is the one
      // thing on this node that means *stopped*, and on a canvas you are scanning rather than
      // reading, a shape catches the eye before a colour does. An octagon and not the ⛔ emoji,
      // which is a tofu box on any machine without an emoji font — and this is the glyph that
      // must never fail to draw.
      className={cn('gap-0.5 px-1.5 py-0 text-[10px] font-bold', GATE_THEME.surface)}
    >
      <OctagonAlert className="size-3" /> gate
    </Badge>
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
      className="font-bold text-amber-700 dark:text-amber-400"
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
    <span className="ml-auto flex items-center gap-1">
      {failureCount > 0 && (
        <span data-testid="failure-count" className="font-bold text-red-700 dark:text-red-400">
          ✗{failureCount}
        </span>
      )}
      <span
        data-testid="assignee"
        title={assigneeHandle}
        className="bg-foreground/85 text-background rounded px-1.5 py-px font-mono text-[10px] tracking-tight"
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
      className={cn('text-[9px] opacity-75', stale && 'font-bold text-amber-700 opacity-100 dark:text-amber-400')}
    >
      last seen {relativeTime(silentFor)} ago
    </span>
  );
}

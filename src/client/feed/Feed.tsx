import { useMemo, useState } from 'react';
import { shortHandle } from '../../shared/handles.ts';
import { taskIdOf } from '../../shared/payload.ts';
import type { FeedMessage, Task } from '../../shared/types.ts';
import { SELECTED_OUTLINE } from '../canvas/theme.ts';
import { CHIP_STYLE } from '../chip.ts';
import { relativeTime } from '../relative-time.ts';
import { type FeedFilter, selectFeed } from './select.ts';
import { colorOfMessage } from './theme.ts';

/**
 * The right dock: what the agents are actually saying to each other, so that an orchestration
 * reads as a conversation and not only as a graph (#12, story 29).
 *
 * It is the **default** panel — the node inspector (#20) swaps in over it on selection, and
 * until then this is what the dock is for. Three controls, and every one of them exists because
 * of a shape the live database really has:
 *
 * - **"Show heartbeats", off.** 65% of all traffic is heartbeats. This is the toggle that
 *   turns a heartbeat ticker back into a feed (SPEC §7.7).
 * - **Scope: this run / All.** You read one orchestration at a time — but `messages.sequence`
 *   is the only true total order the schema has, and a message the server could not attribute
 *   lives in "All" and nowhere else, so "All" is one click away and never the default.
 * - **The task filter**, which is the feed's half of the bidirectional link: select a node and
 *   the feed becomes that task's story, end to end.
 *
 * The first two are *this panel's* state and are held here. The third is not: the task the feed
 * is filtered to is the task the canvas has outlined, and a selection two panels share belongs
 * to neither of them — it belongs to the shell (`App.tsx`), which is the only thing that can
 * see both.
 *
 * `read` and `delivered_at` are **not** rendered anywhere here. They are internal mailbox
 * bookkeeping, not orchestration semantics (SPEC §6.3) — and the server does not even put them
 * on the wire, so this panel could not render them if it wanted to.
 */

export type FeedProps = {
  /** Everything the client has accumulated, oldest first (`feed.ts`). */
  messages: FeedMessage[];
  /** The selected run — the default scope. */
  runId: string | null;
  /** The selected task, when there is one: the feed is then that task's story. */
  selectedTask: Task | null;
  onClearTask: () => void;
  /** Clicking a row: highlight and centre the task it refers to (SPEC §7.6). */
  onSelectMessage: (message: FeedMessage) => void;
};

type FeedScope = 'run' | 'all';

export function Feed({ messages, runId, selectedTask, onClearTask, onSelectMessage }: FeedProps) {
  const [scope, setScope] = useState<FeedScope>('run');
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  const selectedTaskId = selectedTask?.id ?? null;

  const { shown, hidden, now } = useMemo(
    () => viewOf(messages, { runId: scope === 'all' ? null : runId, taskId: selectedTaskId, showHeartbeats }),
    [messages, runId, scope, selectedTaskId, showHeartbeats]
  );

  return (
    <aside
      data-testid="feed"
      aria-label="Message feed"
      style={{
        width: 360,
        flexShrink: 0,
        borderLeft: '1px solid #e4e4e7',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <header style={{ padding: '12px 12px 8px', borderBottom: '1px solid #e4e4e7', flexShrink: 0 }}>
        <h2 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5, color: '#71717a', margin: '0 0 8px' }}>
          Feed
        </h2>

        <div role="group" aria-label="Feed scope" style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
          <ScopeButton label="This run" active={scope === 'run'} onClick={() => setScope('run')} />
          <ScopeButton label="All" active={scope === 'all'} onClick={() => setScope('all')} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#3f3f46' }}>
          <input
            type="checkbox"
            checked={showHeartbeats}
            onChange={(changed) => setShowHeartbeats(changed.target.checked)}
          />
          Show heartbeats
        </label>

        {selectedTask && (
          <button
            type="button"
            data-testid="task-filter"
            onClick={onClearTask}
            title="Stop filtering the feed to this task"
            style={{
              ...CHIP_STYLE,
              display: 'block',
              marginTop: 6,
              maxWidth: '100%',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {selectedTask.title} ✕
          </button>
        )}

        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#71717a' }}>
          {shown.length} {shown.length === 1 ? 'message' : 'messages'}
          {hidden > 0 && <> · {hidden} heartbeats hidden</>}
        </p>
      </header>

      {shown.length === 0 ? (
        <p style={{ margin: 0, padding: 12, fontSize: 12, color: '#71717a' }}>
          {hidden > 0
            ? 'Nothing here but heartbeats — turn on “Show heartbeats” to see them.'
            : emptyWording(selectedTask, scope)}
        </p>
      ) : (
        <ol
          data-testid="feed-rows"
          style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}
        >
          {/*
            Newest first. The feed answers "what just happened" — and a live one that appended
            below the fold would have to be chased down the page, or autoscrolled away from
            under the user's own scrolling.
          */}
          {[...shown].reverse().map((message) => (
            <li key={message.sequence}>
              <Row message={message} now={now} onSelect={onSelectMessage} />
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

type FeedView = {
  shown: FeedMessage[];
  /** What the heartbeat default is costing you, so 466 → 164 is explained rather than mysterious. */
  hidden: number;
  /** The instant the ages are measured from — re-read whenever the feed or the selection does. */
  now: number;
};

/** The rows, the number of them the default is holding back, and the clock they are aged against. */
function viewOf(messages: FeedMessage[], filter: FeedFilter): FeedView {
  return { ...selectFeed(messages, filter), now: Date.now() };
}

/**
 * One message. The subject is a **button when the message resolves to a task** and plain text
 * when it does not — because a message whose `payload.taskId` names a task an
 * `orchestration reset` deleted still belongs in the feed (SPEC §4.2, trap 8). There are no
 * foreign keys in this schema; a broken reference costs the row its link, and nothing else.
 */
function Row({
  message,
  now,
  onSelect,
}: {
  message: FeedMessage;
  now: number;
  onSelect: (message: FeedMessage) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const color = colorOfMessage(message.type);

  // The writer named a task and the server could not find it: the reference is broken, and the
  // row says so rather than looking like a message that never referred to anything.
  const dangling = message.taskId === null && taskIdOf(message.payload) !== null;

  return (
    <article
      data-testid="feed-row"
      data-type={message.type}
      data-sequence={message.sequence}
      data-task={message.taskId ?? undefined}
      style={{ padding: '8px 12px', borderBottom: '1px solid #f4f4f5', fontSize: 12 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {/* The raw type string, whatever it is — an Orca that invents one still names a real
            event, and it is rendered neutral rather than dropped (SPEC §5). */}
        <span
          data-testid="type-chip"
          style={{
            background: color.bg,
            border: `1px solid ${color.border}`,
            color: color.text,
            borderRadius: 4,
            padding: '0 5px',
            fontSize: 10,
            fontWeight: 600,
            whiteSpace: 'nowrap',
          }}
        >
          {message.type}
        </span>

        <code
          title={`${message.fromHandle} → ${message.toHandle}`}
          style={{ fontSize: 10, color: '#71717a', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {shortHandle(message.fromHandle)} → {shortHandle(message.toHandle)}
        </code>

        <Age at={message.createdAt} now={now} />
      </div>

      <div style={{ marginTop: 3 }}>
        {message.taskId === null ? (
          <span
            data-testid="unlinked-subject"
            title={
              dangling
                ? 'This message names a task that is no longer in the database — a reset deleted it.'
                : undefined
            }
            style={{ color: '#3f3f46' }}
          >
            {message.subject}
            {dangling && <span style={{ color: '#a1a1aa' }}> · unlinked</span>}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onSelect(message)}
            title="Show this task on the canvas"
            style={{
              padding: 0,
              border: 'none',
              background: 'none',
              font: 'inherit',
              color: '#1d4ed8',
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {message.subject}
          </button>
        )}
      </div>

      {(message.body !== '' || message.payload !== null) && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            style={{
              marginTop: 3,
              padding: 0,
              border: 'none',
              background: 'none',
              font: 'inherit',
              fontSize: 11,
              color: '#71717a',
              cursor: 'pointer',
            }}
          >
            {expanded ? '▾' : '▸'} details
          </button>

          {expanded && (
            <div data-testid="feed-details">
              {message.body !== '' && <p style={BODY_STYLE}>{message.body}</p>}
              {message.payload !== null && <pre style={PAYLOAD_STYLE}>{JSON.stringify(message.payload, null, 2)}</pre>}
            </div>
          )}
        </>
      )}
    </article>
  );
}

/** How long ago, with the exact instant in the tooltip for when "3m" is not enough. */
function Age({ at, now }: { at: string; now: number }) {
  const instant = Date.parse(at);

  if (Number.isNaN(instant)) {
    // An unreadable timestamp reaches the client verbatim rather than being dropped
    // (`time.ts`), so it is shown verbatim rather than rendered as "NaN ago".
    return (
      <span style={AGE_STYLE} title={at}>
        {at}
      </span>
    );
  }

  return (
    <time dateTime={at} title={new Date(instant).toLocaleString()} style={AGE_STYLE}>
      {relativeTime(now - instant)} ago
    </time>
  );
}

function emptyWording(selectedTask: Task | null, scope: FeedScope): string {
  if (selectedTask) return 'No messages mention this task.';
  return scope === 'all' ? 'No messages in this database yet.' : 'No messages in this run yet.';
}

function ScopeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        padding: '3px 8px',
        borderRadius: 6,
        border: `1px solid ${active ? SELECTED_OUTLINE : '#d4d4d8'}`,
        background: active ? '#eff6ff' : '#ffffff',
        color: active ? '#1e3a8a' : '#3f3f46',
        fontSize: 11,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

const AGE_STYLE = { marginLeft: 'auto', flexShrink: 0, fontSize: 10, color: '#a1a1aa' };

const BODY_STYLE = { margin: '4px 0 0', whiteSpace: 'pre-wrap' as const, color: '#3f3f46' };

const PAYLOAD_STYLE = {
  margin: '4px 0 0',
  padding: 6,
  borderRadius: 4,
  background: '#f4f4f5',
  fontSize: 10,
  overflowX: 'auto' as const,
  color: '#3f3f46',
};

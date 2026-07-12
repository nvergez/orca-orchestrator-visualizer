import { useMemo, useState } from 'react';
import { shortHandle } from '../../shared/handles.ts';
import type { FeedMessage, Task } from '../../shared/types.ts';
import { relativeTime } from '../relative-time.ts';
import { type FeedFilter, visibleMessages } from './select.ts';
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
 * `read` and `delivered_at` are **not** rendered anywhere here. They are internal mailbox
 * bookkeeping, not orchestration semantics (SPEC §6.3) — and the server does not even put them
 * on the wire, so this panel could not render them if it wanted to.
 */

export type FeedProps = {
  /** Everything the client has accumulated, oldest first (`feed.ts`). */
  messages: FeedMessage[];
  /** The selected run — the default scope. */
  runId: string | null;
  scope: FeedScope;
  onScope: (scope: FeedScope) => void;
  showHeartbeats: boolean;
  onShowHeartbeats: (show: boolean) => void;
  /** The selected task, when there is one: the feed is then that task's story. */
  selectedTask: Task | null;
  onClearTask: () => void;
  /** Clicking a row: highlight and centre the task it refers to (SPEC §7.6). */
  onSelectMessage: (message: FeedMessage) => void;
};

export type FeedScope = 'run' | 'all';

export function Feed({
  messages,
  runId,
  scope,
  onScope,
  showHeartbeats,
  onShowHeartbeats,
  selectedTask,
  onClearTask,
  onSelectMessage,
}: FeedProps) {
  const selectedTaskId = selectedTask?.id ?? null;

  const { shown, hidden, now } = useMemo(
    () => select(messages, { runId: scope === 'all' ? null : runId, taskId: selectedTaskId, showHeartbeats }),
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
          <ScopeButton label="This run" active={scope === 'run'} onClick={() => onScope('run')} />
          <ScopeButton label="All" active={scope === 'all'} onClick={() => onScope('all')} />
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#3f3f46' }}>
          <input
            type="checkbox"
            checked={showHeartbeats}
            onChange={(changed) => onShowHeartbeats(changed.target.checked)}
          />
          Show heartbeats
        </label>

        {selectedTask && (
          <button
            type="button"
            data-testid="task-filter"
            onClick={onClearTask}
            title="Stop filtering the feed to this task"
            style={CHIP_STYLE}
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

type Selection = {
  /** The rows to render, oldest first. */
  shown: FeedMessage[];
  /** How many the heartbeat filter is holding back — the number that explains 466 → 164. */
  hidden: number;
  /** The instant the ages are measured from — re-read whenever the selection or the feed does. */
  now: number;
};

/**
 * What is on screen, and what the default is *costing* you.
 *
 * `hidden` is counted rather than implied. A user looking at 164 rows in a database of 466
 * messages is owed the reason, or the tool looks like it lost 300 of them.
 */
function select(messages: FeedMessage[], filter: FeedFilter): Selection {
  const shown = visibleMessages(messages, filter);
  const everything = filter.showHeartbeats ? shown : visibleMessages(messages, { ...filter, showHeartbeats: true });

  return { shown, hidden: everything.length - shown.length, now: Date.now() };
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
              namesATask(message)
                ? 'This message names a task that is no longer in the database — a reset deleted it.'
                : undefined
            }
            style={{ color: '#3f3f46' }}
          >
            {message.subject}
            {namesATask(message) && <span style={{ color: '#a1a1aa' }}> · unlinked</span>}
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

/** Did the writer name a task, whether or not that task still exists? */
function namesATask(message: FeedMessage): boolean {
  const payload = message.payload;
  return typeof payload === 'object' && payload !== null && typeof (payload as { taskId?: unknown }).taskId === 'string';
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
        border: `1px solid ${active ? '#3b82f6' : '#d4d4d8'}`,
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

const CHIP_STYLE = {
  display: 'block',
  marginTop: 6,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap' as const,
  padding: '2px 8px',
  borderRadius: 999,
  border: '1px solid #93c5fd',
  background: '#eff6ff',
  color: '#1e3a8a',
  fontSize: 11,
  cursor: 'pointer',
};

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

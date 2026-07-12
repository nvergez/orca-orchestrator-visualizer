import { useMemo, useState } from 'react';
import type { FeedMessage } from '../../shared/types.ts';
import { SELECTED_OUTLINE } from '../canvas/theme.ts';
import { MessageRow } from './MessageRow.tsx';
import { viewOf } from './select.ts';

/**
 * The right dock's **default** panel: what the agents are actually saying to each other, so that
 * an orchestration reads as a conversation and not only as a graph (#12, story 29).
 *
 * The node inspector swaps in over it on selection and swaps back out when the selection is let
 * go (#20, SPEC §7.1) — **one** panel that swaps, not both stacked, because at this node count
 * the canvas deserves the width. So the feed is the panel for *no selection*, and the two
 * controls it has left are both about which run you are reading:
 *
 * - **"Show heartbeats", off.** 65% of all traffic is heartbeats. This is the toggle that
 *   turns a heartbeat ticker back into a feed (SPEC §7.7).
 * - **Scope: this run / All.** You read one orchestration at a time — but `messages.sequence`
 *   is the only true total order the schema has, and a message the server could not attribute
 *   lives in "All" and nowhere else, so "All" is one click away and never the default.
 *
 * Both are *this panel's* state and are held here. The selection is not: a task the canvas has
 * outlined and the inspector is describing belongs to the shell (`App.tsx`), which is the only
 * thing that can see both.
 *
 * A row is a `MessageRow` — the same component the inspector renders its messages with. Here a
 * subject is a **button** into the task it names (the feed's half of the bidirectional link,
 * SPEC §7.6); there, you are already standing on that task.
 */

export type FeedProps = {
  /** Everything the client has accumulated, oldest first (`feed.ts`). */
  messages: FeedMessage[];
  /** The selected run — the default scope. */
  runId: string | null;
  /** Clicking a row: highlight and centre the task it refers to (SPEC §7.6). */
  onSelectMessage: (message: FeedMessage) => void;
};

type FeedScope = 'run' | 'all';

export function Feed({ messages, runId, onSelectMessage }: FeedProps) {
  const [scope, setScope] = useState<FeedScope>('run');
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  const { shown, hidden, now } = useMemo(
    () => viewOf(messages, { runId: scope === 'all' ? null : runId, showHeartbeats }),
    [messages, runId, scope, showHeartbeats]
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

        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#71717a' }}>
          {shown.length} {shown.length === 1 ? 'message' : 'messages'}
          {hidden > 0 && <> · {hidden} heartbeats hidden</>}
        </p>
      </header>

      {shown.length === 0 ? (
        <p style={{ margin: 0, padding: 12, fontSize: 12, color: '#71717a' }}>
          {hidden > 0
            ? 'Nothing here but heartbeats — turn on “Show heartbeats” to see them.'
            : emptyWording(scope)}
        </p>
      ) : (
        <ol
          data-testid="feed-rows"
          style={{ listStyle: 'none', margin: 0, padding: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}
        >
          {/*
            Newest first. The feed answers "what just happened" — and a live one that appended
            below the fold would have to be chased down the page, or autoscrolled away from
            under the user's own scrolling. (The inspector reads the other way round: one task's
            messages are a story, and a story starts at the beginning.)
          */}
          {[...shown].reverse().map((message) => (
            <li key={message.sequence}>
              <MessageRow message={message} now={now} onSelect={onSelectMessage} />
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function emptyWording(scope: FeedScope): string {
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

import { useState } from 'react';
import { shortHandle } from '../../shared/handles.ts';
import { taskIdOf } from '../../shared/payload.ts';
import type { FeedMessage } from '../../shared/types.ts';
import { ageOf } from '../relative-time.ts';
import { colorOfMessage } from './theme.ts';

/**
 * One message, as both panels that show messages render it.
 *
 * The feed shows the run's traffic newest-first (#18); the inspector shows one task's, oldest
 * first, as a story (#20). What a *row* is does not change between them — type chip, who said it
 * to whom, subject, how long ago, and the body and payload one click away — so it is one
 * component. Two would drift, and the row that fell between them would be exactly the malformed
 * one both are careful about.
 *
 * `onSelect` is what differs, and it differs honestly: in the feed a subject is a **button** that
 * takes you to the task it names, and in the inspector there is nowhere to go — you are already
 * standing on that task. No handler, no button.
 *
 * `read` and `delivered_at` are rendered nowhere: internal mailbox bookkeeping, not orchestration
 * semantics (SPEC §6.3), and the server does not even put them on the wire.
 */

export type MessageRowProps = {
  message: FeedMessage;
  /** The instant the age is measured from — the panel owns the clock, so a list ages in step. */
  now: number;
  /** Clicking the subject goes to the task the message names. Absent ⇒ the subject is text. */
  onSelect?: (message: FeedMessage) => void;
};

export function MessageRow({ message, now, onSelect }: MessageRowProps) {
  const [expanded, setExpanded] = useState(false);
  const color = colorOfMessage(message.type);

  // The writer named a task and the server could not find it: the reference is broken, and the
  // row says so rather than looking like a message that never referred to anything.
  const dangling = message.taskId === null && taskIdOf(message.payload) !== null;
  const linked = message.taskId !== null && onSelect !== undefined;

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
        {linked ? (
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
        ) : (
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
  const age = ageOf(at, now);

  // A string that is not a timestamp is not marked up as one: `<time datetime="…">` would be
  // claiming a machine-readable instant that this very row is saying it does not have.
  if (!age.readable) {
    return (
      <span style={AGE_STYLE} title={age.title}>
        {age.label}
      </span>
    );
  }

  return (
    <time dateTime={at} title={age.title} style={AGE_STYLE}>
      {age.label}
    </time>
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

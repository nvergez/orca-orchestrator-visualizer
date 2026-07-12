import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import { taskIdOf } from '../../shared/payload.ts';
import type { FeedMessage } from '../../shared/types.ts';
import { ageOf } from '../relative-time.ts';
import { themeOfMessage } from './theme.ts';

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
  const theme = themeOfMessage(message.type);

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
      className="hover:bg-muted/40 border-b px-4 py-2.5 text-xs transition-colors last:border-b-0"
    >
      <div className="flex items-center gap-1.5">
        {/* The raw type string, whatever it is — an Orca that invents one still names a real
            event, and it is rendered neutral rather than dropped (SPEC §5). */}
        <Badge
          data-testid="type-chip"
          variant="outline"
          className={cn('rounded px-1.5 py-0 text-[10px] font-semibold', theme.surface)}
        >
          {message.type}
        </Badge>

        <code
          title={`${message.fromHandle} → ${message.toHandle}`}
          className="text-muted-foreground truncate font-mono text-[10px]"
        >
          {shortHandle(message.fromHandle)} → {shortHandle(message.toHandle)}
        </code>

        <Age at={message.createdAt} now={now} />
      </div>

      <div className="mt-1">
        {linked ? (
          <button
            type="button"
            onClick={() => onSelect(message)}
            title="Show this task on the canvas"
            className="text-selection-ink cursor-pointer text-left font-medium hover:underline"
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
            className="text-foreground/90"
          >
            {message.subject}
            {dangling && <span className="text-muted-foreground/70"> · unlinked</span>}
          </span>
        )}
      </div>

      {(message.body !== '' || message.payload !== null) && (
        <>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded(!expanded)}
            className="text-muted-foreground hover:text-foreground mt-1 flex cursor-pointer items-center gap-0.5 text-[11px] transition-colors"
          >
            {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            details
          </button>

          {expanded && (
            <div data-testid="feed-details" className="mt-1.5">
              {message.body !== '' && <p className="text-foreground/80 whitespace-pre-wrap">{message.body}</p>}
              {message.payload !== null && (
                <pre className="bg-muted text-muted-foreground mt-1.5 overflow-x-auto rounded-md p-2 font-mono text-[10px]">
                  {JSON.stringify(message.payload, null, 2)}
                </pre>
              )}
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
  const className = 'text-muted-foreground/70 ml-auto shrink-0 text-[10px] tabular-nums';

  // A string that is not a timestamp is not marked up as one: `<time datetime="…">` would be
  // claiming a machine-readable instant that this very row is saying it does not have.
  if (!age.readable) {
    return (
      <span className={className} title={age.title}>
        {age.label}
      </span>
    );
  }

  return (
    <time dateTime={at} title={age.title} className={className}>
      {age.label}
    </time>
  );
}

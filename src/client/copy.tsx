import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { CHIP_CLASS } from './chip.ts';

/**
 * **Every identifier on this screen, one click from the clipboard.**
 *
 * The tool is read-only (SPEC §1.2), so everything a person *does* with what they read here happens
 * somewhere else: in `orca orchestration`, in a grep of a log, in a message to a colleague. And what
 * every one of those needs is an id — a `task_<hex>`, a `term_<uuid>` — which is precisely the kind
 * of string nobody retypes and nobody remembers. The panels were already showing them; they were
 * showing them as *text*, truncated to eight hex, next to a tooltip with the rest. So the last step
 * of every session was a person squinting at a uuid and typing it out.
 *
 * Two shapes, and the difference is whether the value is worth **reading**:
 *
 * - **`CopyId`** — the id, in full, *as the button*. For the one place a whole id is worth the space
 *   it takes: the inspector's header, where the next thing you do with the task you are looking at
 *   is paste it into a command.
 * - **`CopyButton`** — an icon beside a value already on screen. For the rows — a cast member, a
 *   dispatch attempt, a gate — where the handle is a shortened uuid and a second full copy of it
 *   would be noise. It is quiet until the row is hovered, and it stays reachable by keyboard.
 *
 * **Only ids that mean something outside this tool.** `run_<handle>`, `msg:<sequence>`,
 * `dispatch:<contextId>` are *ours* — inventions of the client and the server (SPEC §4.3, §4.7) —
 * and no `orca` command has ever heard of one. Offering to copy them would be offering a string that
 * looks like an id and works nowhere. What is copyable is what Orca itself wrote: task ids, terminal
 * handles, and the id of the message or row a gate came from.
 */

/** ~1.5 s of "copied" — long enough to be read, short enough not to become the label. */
const COPIED_MS = 1500;

/**
 * The click, and the moment and a half it says so for.
 *
 * `navigator.clipboard` is **absent** outside a secure context — an `http://` origin that is not
 * localhost has none — and it can be *refused* even where it exists. Neither is this tool's to fix,
 * and neither is worth a thrown error in a console: the value is on screen, selectable, either way.
 * So a copy that cannot happen simply does not happen, and the button never lies about it by
 * flashing "copied".
 */
function useCopy(value: string): { copied: boolean; copy: () => void } {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    void navigator.clipboard?.writeText(value).then(
      () => setCopied(true),
      () => undefined
    );
  };

  return { copied, copy };
}

export type CopyIdProps = {
  id: string;
  /** What it is, as a noun phrase: `task id` ⇒ "Copy the task id". */
  label: string;
  className?: string;
};

/**
 * The id itself, and the button is the id — which is what a person needs to *see* when the whole
 * point of the value is that it goes somewhere else verbatim. What the button does with it has to be
 * said too, so the id stays inside the accessible name and the two cannot disagree.
 */
export function CopyId({ id, label, className }: CopyIdProps) {
  const { copied, copy } = useCopy(id);

  return (
    <button
      type="button"
      data-testid="copy-id"
      title={`Copy the ${label}`}
      aria-label={`Copy the ${label} ${id}`}
      onClick={copy}
      className={cn(CHIP_CLASS, 'max-w-full cursor-pointer text-[10px]', className)}
    >
      {/* The id in an element of its own: it is a *value* — the thing you paste into a command —
          and not a label with an icon stuck to the end of it. */}
      <code className="truncate font-mono">{id}</code>

      {copied ? (
        // Said out loud, not only shown: the confirmation is the whole feedback of the click.
        <span role="status" className="flex shrink-0 items-center gap-0.5">
          <Check className="size-3" /> copied
        </span>
      ) : (
        <Copy aria-hidden className="size-3 shrink-0" />
      )}
    </button>
  );
}

export type CopyButtonProps = {
  /** The **whole** value — never the shortened one the row beside it is showing. */
  value: string;
  /** What it is, as a noun phrase: `agent handle` ⇒ "Copy the agent handle". */
  label: string;
  className?: string;
};

/**
 * An icon, beside a value that is already there.
 *
 * The handle on a cast row is eight hex of a uuid and the rest is in a tooltip — because the row is
 * 18rem wide and the uuid is not readable anyway. That is the right call for *reading* and it is
 * useless for *acting*, and this is the two-square-millimetre fix: the shortened value stays, and
 * the whole one is one click away.
 *
 * The accessible name carries the value, so a screen reader hears which handle it is about — and so
 * that two of these in one panel are two different buttons rather than the same one twice.
 */
export function CopyButton({ value, label, className }: CopyButtonProps) {
  const { copied, copy } = useCopy(value);

  return (
    <button
      type="button"
      data-testid="copy-button"
      title={`Copy the ${label}`}
      aria-label={`Copy the ${label} ${value}`}
      onClick={copy}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-accent inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors pointer-coarse:size-9',
        'focus-visible:ring-ring/50 focus-visible:ring-[3px] focus-visible:outline-none',
        className
      )}
    >
      {copied ? (
        <>
          <Check aria-hidden className="text-status-completed-ink size-3.5" />
          {/* The icon swap is silent to a screen reader; the click has to be answered to one too. */}
          <span role="status" className="sr-only">
            copied
          </span>
        </>
      ) : (
        <Copy aria-hidden className="size-3.5" />
      )}
    </button>
  );
}

/**
 * How a copy button rides a row it must not clutter: invisible until the row is hovered, and back
 * the instant the pointer leaves — but **always focusable**, so the keyboard reaches it in tab order
 * and it shows itself when it gets there. (`opacity-0` hides; it does not remove.)
 *
 * On a coarse pointer it is simply visible. SPEC §7.9's "always reachable by keyboard" clause is
 * the intent here, and a thumb is a keyboard with no focus ring: there is no hover to summon the
 * button with and no tab order to stumble onto it by, so hiding it would not be quiet, it would
 * be gone. Every hover-revealed copy button in the rail, cast, gate strip and inspector becomes
 * persistently (and quietly) visible on touch.
 *
 * One string, so the rail, the inspector and the gate strip cannot each pick a different idea of
 * *quiet* — the same reason `CHIP_CLASS` is one string (`chip.ts`).
 */
export const COPY_ON_HOVER =
  'opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100';

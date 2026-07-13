import { ExternalLink } from 'lucide-react';
import { cn } from '@/lib/utils';
import { keyOf } from '../shared/receipt.ts';
import type { ReceiptFact } from '../shared/types.ts';
import { CHIP_CLASS } from './chip.ts';
import { CopyId } from './copy.tsx';

/**
 * The recognized facts of an outcome receipt (#67), rendered — the one renderer both surfaces
 * share, because the conversation's compact summary and the inspector's full receipt are the
 * same interpretation at two depths, and two renderers would drift into two.
 *
 * Two controls, and the difference between them is what claim each fact can honestly make:
 *
 * - **A `link` is an ordinary `<a>`** — the value passed real URL validation on the server
 *   side of the shared reader, and the network is exactly what a URL claims. It opens in a
 *   new tab and hands the receipt's page neither this window nor a referrer, because a
 *   receipt is untrusted text out of a database anyone can write to.
 * - **Everything else is copyable text** — a path, a branch, a ticket id, an agent handle.
 *   A path is *not* linkified: it was true on the worker's machine at completion time, and
 *   this machine was never promised to have it (SPEC §12.4). Copying is the one act that
 *   makes no further claim, and it is the same affordance every Orca id already wears
 *   (`copy.tsx`).
 *
 * `showSources` is the inspector's: the provenance under every fact, on screen — which is
 * what makes the *merged* receipt honest, because a deduplicated fact says both columns that
 * stated it and a conflict visibly names its sides. The conversation leaves it off: a turn is
 * one source, already captioned underneath (`turn.source`), and the whole receipt is one
 * click away.
 */

export type ReceiptFactsProps = {
  facts: ReceiptFact[];
  /** How many facts the compact cap cut (`Turn.receiptOmitted`). The inspector never cuts. */
  omitted?: number;
  /** Render each fact's provenance visibly — the inspector's mode. */
  showSources?: boolean;
  testId?: string;
};

/**
 * How each copyable kind presents: what the copy button calls the value (`Copy the branch
 * nvergez/67`), and whether that word is also said beside the chip — `68` is a ticket only if
 * told so, while a path already says what it is. One table, so a new kind cannot get a label
 * in one place and forget the caption in the other.
 */
const KIND_LOOK: Record<Exclude<ReceiptFact['kind'], 'link'>, { label: string; captioned: boolean }> = {
  branch: { label: 'branch', captioned: true },
  ticket: { label: 'ticket', captioned: true },
  agent: { label: 'completing agent', captioned: true },
  report: { label: 'report path', captioned: true },
  file: { label: 'file path', captioned: false },
};

export function ReceiptFacts({ facts, omitted = 0, showSources = false, testId = 'receipt' }: ReceiptFactsProps) {
  if (facts.length === 0) return null;

  return (
    <ul data-testid={testId} className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {facts.map((fact) => (
        <li
          key={keyOf(fact)}
          // `min-w-0` is what makes the chip's own `max-w-full` bind: a flex item's automatic
          // minimum size is its *content*, so without this the row simply grows to fit a 90-character
          // path and the truncation inside it never comes into play. It cost nothing while the
          // receipt lived in panels wider than its longest fact; the report's outcome column is
          // narrower than one, and a chip that painted across the next column was the proof.
          className={cn('flex min-w-0 max-w-full items-center gap-1', showSources && 'w-full flex-wrap')}
        >
          {fact.kind !== 'link' && KIND_LOOK[fact.kind].captioned && (
            <span className="text-muted-foreground shrink-0 text-[10px]">{KIND_LOOK[fact.kind].label}</span>
          )}

          {fact.kind === 'link' ? (
            <a
              data-testid="receipt-link"
              href={fact.value}
              target="_blank"
              rel="noopener noreferrer"
              title={fact.value}
              className={cn(CHIP_CLASS, 'max-w-full')}
            >
              <ExternalLink aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{fact.value}</span>
            </a>
          ) : (
            // `min-w-0` for the reason the `<li>` above has it, one level further in: the chip
            // shares its line with the kind's caption ("completing agent"), and a flex item that
            // will not shrink below its content pushes a 40-character handle straight through the
            // next column. The `truncate` inside it has been waiting for a bound to truncate at.
            <CopyId id={fact.value} label={KIND_LOOK[fact.kind].label} className="min-w-0" />
          )}

          {/* The provenance, said out loud — the same small grey truth-telling every turn's
              `source` caption does, and the licence for deduplicating at all (#67). */}
          {showSources && (
            <span data-testid="receipt-sources" className="text-muted-foreground/70 w-full font-mono text-[10px]">
              {fact.sources.join(', ')}
            </span>
          )}
        </li>
      ))}

      {omitted > 0 && (
        <li data-testid="receipt-omitted" className="text-muted-foreground text-[10px]">
          +{omitted} more · the inspector has the whole receipt
        </li>
      )}
    </ul>
  );
}

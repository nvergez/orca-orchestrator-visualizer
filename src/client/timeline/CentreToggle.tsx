import { GitBranch, GanttChartSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { PANEL_CLASS } from '../surface.ts';

/**
 * **The centre's two views** (#72, SPEC §14.4) — the same selected run, read two ways.
 *
 * The DAG stays the default, and that is a ruling rather than a preference: the dependency graph is
 * what the tool *is*, and the timeline answers questions you go looking for (who overlapped whom;
 * how many times did we have to ask) rather than the one you arrive with.
 *
 * **It is a lens, not a navigation.** Pressing it changes what the centre draws and *nothing else* —
 * not the selected run, not the agent the whole screen is pivoted on, not the open task. That is the
 * first acceptance criterion of the ticket, and it is easy to get wrong: a toggle that reset the
 * selection would be a view pretending to be a page, and a reader who pressed it to *look* at
 * something would find they had navigated away from it.
 *
 * Mechanically that means this component owns nothing at all. It is two buttons and a callback; the
 * shell holds the one piece of state, beside the selections it deliberately does not touch.
 */

export type CentreView = 'dag' | 'timeline';

const VIEWS = [
  { view: 'dag', label: 'DAG', icon: GitBranch, hint: 'Dependencies — what waited on what' },
  { view: 'timeline', label: 'Timeline', icon: GanttChartSquare, hint: 'Attempts on the clock — who worked when' },
] as const;

export function CentreToggle({ view, onChange }: { view: CentreView; onChange: (view: CentreView) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Centre view"
      className={cn(PANEL_CLASS, 'flex shrink-0 items-center gap-0.5 p-0.5')}
    >
      {VIEWS.map((entry) => {
        const selected = view === entry.view;

        return (
          <button
            key={entry.view}
            type="button"
            role="tab"
            aria-selected={selected}
            title={entry.hint}
            onClick={() => onChange(entry.view)}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors pointer-coarse:py-2',
              selected ? 'bg-selection/15 text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <entry.icon aria-hidden className="size-3.5" />
            {entry.label}
          </button>
        );
      })}
    </div>
  );
}

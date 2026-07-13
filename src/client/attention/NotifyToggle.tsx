import { Bell, BellOff, BellRing, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AttentionNotifications, NotifyState } from './notify.ts';

/**
 * **The opt-in** (#60) — one bell, on the top bar, next to the other control that is about the
 * *reader* rather than about the database (`ThemeToggle`).
 *
 * It is the tool's only permission-requesting surface, and that is the point: a browser will raise
 * its notification dialog **only** from a user gesture, and a page that raises one before it has
 * shown you anything is the page you deny out of reflex. So the ask lives on a click, and the
 * click lives here.
 *
 * **Its four states are four different truths, and it tells them apart** — because the reader can
 * only act on one of them. `blocked` is a decision *they* made in the browser's own settings and
 * can go and undo; `unavailable` is a browser that has no notifications to give (or one that
 * refuses to construct one — Chrome on Android), and there is nothing to undo at all. Collapsing
 * the two into a greyed bell with no words would leave a reader who denied us once staring at a
 * control they cannot fix and were never told how to.
 *
 * In every one of those states the tab still counts what needs attention (`tab.ts`), which is what
 * makes a disabled bell an honest thing to show rather than a broken one.
 */

const LOOK: Record<NotifyState, { icon: LucideIcon; label: string; ink?: string }> = {
  on: {
    icon: BellRing,
    label: 'Stop notifying me when something new needs attention',
    // The one state that is *doing* something wears the page's own accent; the rest are quiet.
    ink: 'text-foreground',
  },
  off: { icon: Bell, label: 'Notify me when something new needs attention' },
  blocked: {
    icon: BellOff,
    label: "Desktop notifications are blocked in this browser's settings — the tab still counts what needs attention",
  },
  unavailable: {
    icon: BellOff,
    label: 'Desktop notifications are not available in this browser — the tab still counts what needs attention',
  },
};

export function NotifyToggle({ state, toggle }: AttentionNotifications) {
  const look = LOOK[state];
  const Icon = look.icon;
  const inert = state === 'blocked' || state === 'unavailable';

  return (
    <Button
      type="button"
      data-testid="notify-toggle"
      data-state={state}
      variant="ghost"
      size="icon"
      // **`aria-disabled`, and not `disabled`** — the difference is the whole point of the two
      // inert states. shadcn's button carries `disabled:pointer-events-none`, so a truly disabled
      // bell cannot be hovered and cannot be focused: its `title` would never appear and a screen
      // reader would skip past it. The one state a reader can actually *fix* — `blocked`, which
      // they set in the browser's own settings — would be the one state that could not tell them
      // how. So it stays hoverable, focusable and readable, and simply does nothing: `toggle`
      // already refuses (`notify.ts`), which is where an inert control's inertness belongs.
      aria-disabled={inert}
      aria-pressed={state === 'on'}
      onClick={toggle}
      // The label *is* the explanation, in both directions: a screen reader reads it as the
      // button's name, and a pointer gets it as the tooltip. There is nowhere else on the bar for
      // a sentence, and a bell that could not say why it was grey would be furniture.
      aria-label={look.label}
      title={look.label}
      className={cn(
        'text-muted-foreground size-7 shrink-0 pointer-coarse:size-10',
        // It reads as "not here" — and it must not read as a bug, which is why it keeps its
        // tooltip and its place in the tab order while losing only the affordance to be pressed.
        inert ? 'cursor-default opacity-50' : 'hover:text-foreground cursor-pointer',
        look.ink
      )}
    >
      <Icon className="size-4" />
    </Button>
  );
}

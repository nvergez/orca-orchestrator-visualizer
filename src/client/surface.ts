/**
 * What a panel *is* (SPEC §7.9).
 *
 * The old shell was four regions divided by 1px lines — a document with rules drawn on it. This
 * one is a **field** with **panels standing on it**: the field is darker than anything on it, the
 * panels are lit, translucent and cast a shadow, and the gap between them is the field showing
 * through. That single change is most of what makes the tool read as an instrument, and it is a
 * change to a border, a radius and a shadow — no layout moved.
 *
 * One string, in one place, for the same reason `dock.ts` was one string: three panels that are
 * the same *kind* of object must not be able to disagree about what that object looks like.
 */

/** A floating panel: translucent over the field, hairline border, lifted. */
export const PANEL_CLASS =
  'rounded-xl border border-panel-border bg-panel shadow-lift-2 backdrop-blur-xl';

/**
 * The field the panels stand on — the page's own background, plus the two things that give it
 * depth: a fine grid, and a soft glow behind where the work is.
 *
 * The grid is what a canvas *is*: it says "this is a surface with coordinates on it" before a
 * single node has loaded. It is drawn at 4.5% opacity, which is below the threshold at which it
 * competes with anything, and above the one at which it may as well not be there.
 */
export const FIELD_CLASS = 'relative isolate flex h-full flex-col gap-2 bg-field p-2';

/** The grid + the glow, as a layer. Behind everything (`-z-10`), and never in the way. */
export const FIELD_BACKDROP_STYLE = {
  backgroundImage: [
    'radial-gradient(60% 50% at 50% 0%, var(--field-glow), transparent)',
    'linear-gradient(to right, var(--grid-line) 1px, transparent 1px)',
    'linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
  ].join(', '),
  backgroundSize: '100% 100%, 32px 32px, 32px 32px',
} as const;

/**
 * The right dock — **one** panel, and it *swaps* (SPEC §7.1): the message feed by default, the
 * node inspector while a task is selected. Never both stacked, because at this node count the
 * canvas deserves the width.
 *
 * So there is one shell, in one place. Two panels that are the same panel at different moments
 * must not be able to disagree about how wide they are or which edge they draw — a dock that
 * changed width on selection would jolt the canvas it is beside every time you clicked a node.
 */
export const DOCK_CLASS = `${PANEL_CLASS} flex w-[22rem] min-h-0 shrink-0 flex-col overflow-hidden`;

/** A panel's header: the strip that names it, held to the panel's own translucency. */
export const PANEL_HEADER_CLASS = 'flex shrink-0 flex-col gap-2.5 border-b border-panel-border/70 px-4 py-3';

/** The small-caps label every panel header wears. One typographic voice for "this is a panel". */
export const PANEL_TITLE_CLASS = 'text-muted-foreground text-[11px] font-semibold tracking-widest uppercase';

# The folding field — mobile design contract

**Status:** design contract for the mobile-responsive pass, synthesized from the winning
"Folding Field" proposal with the judge panel's grafts resolved (adopted or declined, with
reasons, in §9). Every file path, line number and class string below was verified against the
code as of this writing.

**One sentence:** the desktop shell is a row of three panels standing on a field; on a phone the
same row folds into a column of the same three panels — the rail becomes a collapsible band at
the top, the canvas keeps the middle, the dock becomes a collapsible band at the bottom — and
nothing is a new screen, no panel is mounted differently, and the page still never scrolls.

**The hard constraint, stated once:** desktop (≥ 64rem, fine pointer) must remain **visually and
behaviorally byte-identical**. Every mechanism in this document is chosen to make that provable
rather than merely intended (§8).

---

## 1. The shape of the change

The mockup's own `@media (max-width: 1100px)` rules — the design canon's only precedent for a
narrow screen — stack the shell vertically in rail → canvas → dock order. This contract is that
instinct, re-expressed in the shipped §7.9 language (panels floating on a gridded field) instead
of the mockup's border chrome.

Why a reflow and not tabs or sheets:

- **A tab bar hides panels**, and two of the things the panels hold are not allowed to hide: an
  open gate must interrupt (SPEC §7.4), and the rail's live dot / blocked octagon are the "which
  one matters" answer the whole rail exists for (SPEC §7.2). Bands keep both on screen at rest.
- **A sheet overlays the canvas**; a band *pushes* it. Pushing means the visible canvas is the
  real React Flow viewport, so `CentreOnSelection` (`src/client/canvas/Canvas.tsx:263-293`)
  centres a selected node in the space the reader can actually see, with no offset math and no
  centring finishing underneath an overlay.
- **The page never scrolls** (`body { overflow-hidden }`, `src/client/index.css:301-306` — "a
  tool, not a document"). Bands expand and collapse instead. That single decision dissolves the
  two React Flow traps by construction: there is no page scroll for the canvas pane to trap, and
  the canvas is never `display: none`, so it never initializes or centres against a 0×0
  container.

The mechanism is three tools, used with total discipline:

1. **`max-lg:`-prefixed classes appended to existing elements.** Desktop computed styles are
   untouched because every new token is scoped below the breakpoint. No un-prefixed class is
   ever edited.
2. **`lg:contents` wrapper divs** where mobile needs a container desktop must not have —
   `display: contents` erases the wrapper from desktop layout entirely.
3. **One `useIsMobile()` hook** for the handful of *behaviors* classes cannot express
   (band auto-open/close, re-fit on rotation, the mobile-only chrome). It returns `false`
   wherever `matchMedia` is absent, so all 119 existing jsdom tests render exactly today's app.

Mobile-only *interactive chrome* (band toggles, the dock handle, the agent-filter chip, the
"new exchanges" chip) is **conditionally rendered on `useIsMobile()`**, never merely
class-hidden. Class hiding is invisible to jsdom (no stylesheet loads), so JS-conditional
rendering is what keeps the mobile chrome out of the 119 existing tests' queries — and what
makes the desktop-guard test (§10, test 1) mean something.

---

## 2. The breakpoint, and the one hook

### 2.1 The breakpoint is Tailwind's `lg` (64rem / 1024px)

The fixed-width math forces it: 18rem rail (`src/client/rail/RunRail.tsx:80`) + 22rem dock
(`src/client/surface.ts:47`) + three `gap-2` + two `p-2` ≈ 656px before the canvas gets a
pixel, and a canvas worth standing between two panels needs ~300px more. 1024 is the honest
floor — and it is the one breakpoint the codebase already uses (`hidden … lg:flex` on
"Last write", `src/client/App.tsx:377`), so the app already implicitly defines "big" as `lg`.
Everything below `lg` — phones in both orientations, small tablets — gets the folded column.

### 2.2 `useIsMobile()` — new file `src/client/viewport.tsx`

`.tsx` deliberately: the react-hooks eslint plugin is scoped to `.tsx` files
(`eslint.config.js`), and a hook in a `.ts` file would dodge `rules-of-hooks` and
`exhaustive-deps`.

```tsx
import { useSyncExternalStore } from 'react';

/**
 * Whether the shell is folded — SPEC §7.1's three-panel row re-expressed as a column below
 * Tailwind's `lg` (64rem), the width under which 18rem of rail plus 22rem of dock leave the
 * canvas nothing.
 *
 * `matchMedia` is read through `?.` for the same reason `theme-mode.ts` reads it that way:
 * jsdom does not implement it, and its absence must mean *desktop* — so the whole existing
 * suite goes on testing the signed-off layout untouched, and a mobile assertion is something a
 * test opts into by stubbing (`vi.stubGlobal('matchMedia', …)`), never something it falls into.
 */
const QUERY = '(max-width: 63.9375rem)';

function subscribe(onChange: () => void): () => void {
  const mql = globalThis.matchMedia?.(QUERY);
  if (!mql) return () => {};
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return globalThis.matchMedia?.(QUERY).matches ?? false;
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
```

Notes pinned here so implementers do not re-litigate them:

- `63.9375rem` = 1023px. Tailwind v4's `max-lg:` compiles to `(width < 64rem)`; the legacy
  `max-width` syntax is used in the hook for `matchMedia` compatibility. The two can disagree
  only on fractional widths strictly between 1023 and 1024 CSS pixels — accepted.
- `useSyncExternalStore` + `addEventListener('change', …)` is chosen because it is the
  fakeable seam (the `FakeEventSource` idiom of `test/client/live.test.tsx`), and because the
  server-snapshot argument (`() => false`) documents the desktop default a third time.
- No enums, no parameter properties (`erasableSyntaxOnly`, tsconfig.json); type-only imports
  say `import type` (`verbatimModuleSyntax`).

### 2.3 The jsdom story

- `test/client/jsdom-gaps.ts` shims exactly `ResizeObserver`, `DOMMatrixReadOnly`, element
  geometry (fallback viewport 1200×800, line 52) and `getBBox`. **It gains no `matchMedia`
  shim** — its own doc comment forbids becoming a seam the suite asserts on.
- Mobile suites install a `FakeMatchMedia` (new file `test/client/fake-match-media.ts`, §10)
  via `vi.stubGlobal('matchMedia', …)` and remove it with `vi.unstubAllGlobals()`; its change
  dispatch is `act()`-wrapped, mirroring `FakeEventSource.push()`.
- Mobile tests assert *behavior* (`aria-expanded`, mount/unmount, `inert`) and *class-string
  presence* (the `toHaveClass(...STATUS_THEME…)` idiom of canvas.test.tsx), never computed
  visibility — jsdom loads no stylesheet.

### 2.4 Touch is orthogonal to width: `pointer-coarse:`

Touch affordances (persistently visible copy buttons, bigger hit targets) use Tailwind v4's
built-in `pointer-coarse:` variant, not the breakpoint. A touch-primary large tablet gets
visible copy buttons at desktop layout — which is the *intent* of §7.9's hover-quiet rule
("quiet until the row is hovered **and always reachable by keyboard**"): hover does not exist
on touch, so persistent-quiet is the same promise kept. This is technically a visible change on
touch-primary desktop hardware (Surface-class devices) and is called out for sign-off in §11.

---

## 3. The mobile information architecture

Portrait phone, top to bottom — one column, all panels present, two of them folded:

```
┌────────────────────────────┐
│ TopBar (condensed)         │  wordmark + separator gone, path clamped, sentence wraps
│ Notices (when present)     │  unchanged content, capped with internal scroll
│ ▸ RAIL BAND (collapsed)    │  h-12: RadarDot · run label · ⛔ octagon · new-run dot
│                            │        · run count · ⌄  — plus [A2 ✕] chip when filtered
│ ⚠ GATE BANNER (if open)    │  compressed GateStrip, max-h-28, still above the canvas
│                            │
│        CANVAS              │  flex-1, always visible, floored at min-h-24
│    (pan/zoom, pulses)      │
│                            │
│ ▴ DOCK HANDLE (collapsed)  │  h-12: "Conversation · 42 exchanges" or the task title · ⌃
└────────────────────────────┘
```

Rules of the fold:

- **Both bands collapsed is the resting state.** First sight is the canvas of the
  most-recently-active run, pulses included — the tool's identity view. The collapsed rail band
  names which run you are looking at and whether it is alive, blocked, or filtered; the
  collapsed dock handle names what the other panel would tell you.
- **Bands push, never overlay.** Expanding the rail band (to `max-h-[45dvh]`) or the dock band
  (to `h-[min(60dvh,32rem)]`) shrinks the canvas beneath/above it. "The canvas deserves the
  width" (SPEC §7.1) becomes: the canvas owns whatever height the reader has not spent.
- **The GateStrip is never foldable.** It keeps the exact slot the doc comment at
  `src/client/App.tsx:210-215` demands — above the canvas, unprompted, whenever the selected
  run has open gates. It compresses; it does not hide (canon trap 1).
- **Notices stay put** — they are content, not decoration (canon trap 8); a long degraded list
  gets an internal scroll cap instead of truncation.
- **The dock swap is untouched.** `selectedTask ? <Inspector/> : <Conversation/>`
  (`src/client/App.tsx:240-262`) is byte-identical on both form factors — one panel that
  swaps, never both (canon trap 2). On mobile the swap happens inside the band.
- **The Connecting screen** (`src/client/App.tsx:471-514`) is centered flex with no fixed
  widths — already mobile-safe, deliberately untouched.

---

## 4. The contract, file by file

Every change below is either an **appended prefixed token** on an existing element, an
**optional prop with a default that reproduces today's behavior**, or **new chrome rendered
only when `useIsMobile()` is true**. Nothing else is permitted.

### 4.1 `src/client/viewport.tsx` — NEW

Exactly §2.2, with the house doc comment (cite the `theme-mode.ts:51` precedent for the
`matchMedia?.` guard and SPEC §7.1 for why 64rem is the fold). ~50 lines with the comment.

### 4.2 `src/client/surface.ts`

One edit — `DOCK_CLASS` (line 47) gains prefixed tokens only:

```ts
export const DOCK_CLASS = `${PANEL_CLASS} flex w-[22rem] min-h-0 shrink-0 flex-col overflow-hidden max-lg:min-h-0 max-lg:w-full max-lg:flex-1 max-lg:shrink`;
```

One string, so Conversation and Inspector still cannot disagree about their dimensions — the
line-43 invariant survives; below `lg` they are both "the band's full width, the band's
remaining height". The band wrapper in App controls the height itself, so neither panel's
internals change. Extend the file's doc comment with one paragraph recording the surface
doctrine for any *future* overlay layer (none exists in this design): a surface that fully
covers the canvas should be `bg-panel-solid` + `shadow-lift-3` — blur is wasted when nothing
meaningful shows through.

### 4.3 `src/client/motion.ts`

One new variant, same accent, placed beside `DOCK_IN` (lines 83-87):

```ts
/**
 * A dock panel arriving on the folded shell (below `lg`) — it rises from the bottom edge it
 * lives on, exactly as DOCK_IN comes from the right edge it lives on. Collapse is instant, for
 * the same reason dock exits are instant (`App.tsx`): animating a fold is animating the user's
 * own tap back at them.
 */
export const BAND_IN: Variants = {
  hidden: { opacity: 0, y: 10 },
  shown: { opacity: 1, y: 0 },
};
```

Used by Conversation and Inspector as their entrance variants when `useIsMobile()` is true
(§4.10, §4.11) — through the existing `initial={enter('hidden')}` path, so `skipAnimations`
and reduced-motion get frame-one finality for free. No fourth living gesture is added: ring,
radar and aurora remain the only things that move at rest.

### 4.4 `src/client/copy.tsx`

- `COPY_ON_HOVER` (line 161) becomes:

  ```ts
  export const COPY_ON_HOVER = 'opacity-0 group-hover/copy:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100';
  ```

  Update its doc comment: §7.9's "always reachable by keyboard" clause is the intent, and a
  thumb is a keyboard with no focus ring. Every hover-revealed copy button in the rail, cast,
  gate strip and inspector becomes persistently (and quietly) visible on touch.
- `CopyButton` base classes (line 133): `size-6` gains `pointer-coarse:size-9`. Callers that
  override to `size-5` add `pointer-coarse:size-8` at their own call sites (owned by those
  files' work items: `Inspector.tsx:412`, `Inspector.tsx:495`, `RunRail.tsx:300`). `cn`'s
  tailwind-merge keeps the un-prefixed and `pointer-coarse:` size groups independent, so a bare
  `size-5` override still inherits the base `pointer-coarse:size-9` — also acceptable.

### 4.5 `src/client/index.css`

One addition, in the existing "React Flow's chrome, painted from ours" block (after line 517):

```css
/* A thumb needs ~36px where a pointer needed 26. Same block that skins these buttons. */
@media (pointer: coarse) {
  .react-flow__controls-button {
    min-height: 2.25rem;
    min-width: 2.25rem;
  }
}
```

**No height-chain change**: `html, body, #root { h-full }` (lines 295-299) already tracks the
small viewport; every new mobile height uses `dvh` only inside band classes in App.

### 4.6 `src/client/App.tsx` — the fold itself (the one shell item)

New imports: `useIsMobile` from `./viewport.tsx`; `ChevronUp` from `lucide-react`; `themeOf`
from `./canvas/theme.ts` (App already imports `GATE_THEME` from it); `exchangeCount,
selectTurns` from `./conversation/select.ts`; `PANEL_TITLE_CLASS` from `./surface.ts`;
`CHIP_CLASS` from `./chip.ts`; `X` from `lucide-react` is *not* needed here (the agent chip
lives in RunRail).

**New state** (beside `selectedAgent`/`selectedTaskId`, line 107-108):

```tsx
const isMobile = useIsMobile();
const [railOpen, setRailOpen] = useState(false);
const [dockOpen, setDockOpen] = useState(false);
const [crossRunFrom, setCrossRunFrom] = useState<string | null>(null);
const [refitSignal, setRefitSignal] = useState(0);
const dockRun = useRef<string | null>(null); // which run the dock band was opened on
```

`railOpen`/`dockOpen` exist on desktop but nothing reads them there; every behavior below is
`isMobile`-guarded so desktop state never churns.

**The restack** — the panel row (line 198):

```tsx
<div className="flex min-h-0 flex-1 gap-2 max-lg:flex-col">
```

That one appended class is the fold: DOM order rail → center → dock becomes top → middle →
bottom, the mockup's approved order.

**The rail band** — RunRail (lines 199-207) gains one prop, passed only on mobile:

```tsx
<RunRail
  …existing props unchanged…
  fold={isMobile ? { folded: !railOpen, onToggle: () => setRailOpen((open) => !open) } : undefined}
/>
```

**The canvas floor** — the canvas wrapper (line 218):

```tsx
<div className="min-h-0 flex-1 max-lg:min-h-24">
```

so an expanded band + gate + notices can never crush React Flow to 0×0 — `CentreOnSelection`
and the fit math never see a zero container.

**The dock band** — wrap the existing `{selectedTask ? <Inspector/> : <Conversation/>}` block
(lines 240-262) in two wrappers plus a mobile-only handle. Tests never assert parent/child
nesting, so wrappers are safe:

```tsx
<div
  className={cn(
    'lg:contents',
    'max-lg:flex max-lg:min-h-0 max-lg:flex-col max-lg:gap-2',
    dockOpen
      ? 'max-lg:h-[min(60dvh,32rem)] max-lg:min-h-24 max-lg:shrink'
      : 'max-lg:h-12 max-lg:shrink-0'
  )}
>
  {isMobile && <DockHandle …see below… />}

  <div
    data-testid="dock-band-body"
    inert={isMobile && !dockOpen ? true : undefined}
    aria-hidden={isMobile && !dockOpen ? true : undefined}
    className="lg:contents max-lg:flex max-lg:min-h-0 max-lg:flex-1 max-lg:flex-col"
  >
    {selectedTask ? <Inspector … /> : <Conversation … />}
  </div>
</div>
```

On desktop both wrappers are `display: contents` and the handle does not render — the flex row
sees the same dock child it sees today. On mobile, collapsed means only the h-12 handle shows;
the clipped panel is `inert` + `aria-hidden` so Tab cannot land on invisible rows (React 19
supports boolean `inert`). The clamp lives on the wrapper; neither dock panel's internals
change, and Conversation still unmounts on selection, so its scope-reset behavior stays
byte-identical (deliberate — DOCK report §7a).

**`DockHandle`** — a new private component in App.tsx, rendered only on mobile. It is a small
floating panel of its own (the collapsed band *is* a panel standing on the field):

```tsx
function DockHandle({ task, count, open, onToggle }: {
  task: Task | null;      // the selected task, or null while the dock holds the conversation
  count: number;          // run-scoped exchange count (heartbeats excluded)
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-testid="dock-band-toggle"
      aria-expanded={open}
      onClick={onToggle}
      className={cn(PANEL_CLASS, 'flex h-12 w-full shrink-0 cursor-pointer items-center gap-2 px-4 text-left')}
    >
      {task ? (
        <>
          <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', themeOf(task.status).dot)} />
          <b className="min-w-0 truncate text-[13px] font-semibold">{task.title}</b>
        </>
      ) : (
        <>
          <span className={PANEL_TITLE_CLASS}>Conversation</span>
          <span className="text-muted-foreground/70 text-[11px] tabular-nums">
            {count} {count === 1 ? 'exchange' : 'exchanges'}
          </span>
        </>
      )}
      <ChevronUp className={cn('text-muted-foreground ml-auto size-4 shrink-0 transition-transform', open && 'rotate-180')} />
    </button>
  );
}
```

A `<span>`, not an `<h2>` — a second "Conversation" heading would collide with the panel's own
in role queries. The ticking exchange count is the unread signal, for free (heartbeats already
excluded by `exchangeCount`, `conversation/select.ts`). The count is derived in App, memoized,
and computed only on mobile so desktop does no extra work per push:

```tsx
const dockCount = useMemo(
  () => (isMobile ? exchangeCount(selectTurns(turns, { runId: selected?.id ?? null, agentHandle: selectedAgent })) : 0),
  [isMobile, turns, selected, selectedAgent]
);
```

This mirrors Conversation's default `'run'` scope; the panel's internal "All" toggle is a view
choice the handle deliberately does not track.

**Behavior rules** — each a one-line, `isMobile`-guarded addition inside existing handlers:

| Gesture | Existing effect (unchanged) | Mobile addition |
|---|---|---|
| `selectTask` (node tap, lines 160-162) | toggles `selectedTaskId` | `setDockOpen(true)` when selecting (not when toggling off); `setCrossRunFrom(null)` |
| `showTask` (gate/dep/turn, lines 176-183) | selects, hops runs, clears agent on hop | `openDock()`; on a hop, `setCrossRunFrom(selected?.label ?? null)` **before** `select(target.runId)`; on a non-hop, `setCrossRunFrom(null)` |
| agent select (the `onSelectAgent` prop becomes a wrapper) | sets `selectedAgent` | `setRailOpen(false)` — the tap's meaning is "show me the dimmed canvas and the dialogue"; exits are instant (SPEC §7.9) |
| `selectRun` (lines 153-157) | selects, clears agent + task | rail **stays open** — the cast just unfolded under the tapped row, and the cast is where the central gesture lives; `setCrossRunFrom(null)` |
| Inspector `onClose` (line 251) | clears `selectedTaskId` | `setCrossRunFrom(null)`; dock band stays open — the Conversation returns in the same band at the same height |
| dock handle toggle | — | `toggleDock()` (below) |

The dock open/close helpers carry the re-fit bookkeeping (§4.9):

```tsx
function openDock(): void {
  if (isMobile && !dockOpen) dockRun.current = selected?.id ?? null;
  if (isMobile) setDockOpen(true);
}
function toggleDock(): void {
  if (!isMobile) return;
  if (dockOpen && selected?.id !== dockRun.current) setRefitSignal((n) => n + 1);
  if (!dockOpen) dockRun.current = selected?.id ?? null;
  setDockOpen((open) => !open);
}
```

`refitSignal` is passed to Canvas as a new optional prop. It fires only when the band collapses
after the run changed while it was expanded — the cross-run `showTask` case, where the initial
fit ran against the shrunken strip — so dismissal lands on a freshly framed graph. Inspector
receives `hoppedFrom={isMobile ? crossRunFrom : null}` — the read carries the same guard as
every write, so a hop narrated on a phone is not still narrating after the window widens into
the desktop dock (§4.11, §8 rule 3).

**TopBar condensation** — classes on existing elements, plus nothing conditional:

- Bar (line 293): `h-13` gains `max-lg:h-auto max-lg:min-h-13 max-lg:py-2
  max-lg:landscape:min-h-11 max-lg:landscape:py-1` — the bar may grow a line so the liveness
  sentence is never cut.
- Wordmark `<b>` (line 304) and the `Separator` (line 307): `max-lg:hidden`. The mark
  identifies; the wordmark and the ornament go first.
- Status pill `<p>` (lines 332-339): `shrink-0` gains `max-lg:min-w-0 max-lg:shrink` — the
  spec-pinned sentence (SPEC §6.1) **wraps** instead of truncating; the wording is content, not
  decoration (canon trap 8), so it is kept whole and the bar pays the line.
- DB path `<dd>` (line 363): `max-w-[26rem]` gains `max-lg:max-w-[30vw]`. It already
  truncates; the full path stays in the DOM. (On touch the `title` tooltip is dead — accepted:
  the full path is also the first line the server prints at boot; recorded in §11.)
- "Last write" (line 377) is already `hidden … lg:flex` — untouched, and now genuinely earning
  that class.
- ThemeToggle (line 394): `size-7` gains `pointer-coarse:size-10`.

**Notices** (lines 421-428): the motion.div gains
`max-lg:max-h-24 max-lg:overflow-y-auto max-lg:landscape:max-h-16` — a long degraded list
scrolls internally instead of eating the canvas. Contents, `role="status"` and `data-state`
attributes untouched.

### 4.7 `src/client/rail/RunRail.tsx`

**New optional prop** (desktop passes nothing; today's call sites compile unchanged):

```ts
export type RailFold = {
  /** True while the band is collapsed to its summary row. */
  folded: boolean;
  onToggle: () => void;
};
// RunRailProps gains:
fold?: RailFold;
```

**Root** (line 80): `w-[18rem] shrink-0` gains `max-lg:w-full max-lg:shrink`, plus a
fold-driven clamp appended via `cn`:

```tsx
fold && 'max-lg:min-h-12',
fold && (fold.folded ? 'max-lg:max-h-12' : 'max-lg:max-h-[45dvh]')
```

The `min-h-12` is the band's floor. The folded column can be over-asked — an open dock band
wants `60dvh` of it — and a `shrink` panel with no floor is a panel flexbox will take to
zero, which on a real phone deleted the summary row entirely (found in the 390px screenshot
pass). One summary row is what the fold owes the reader, so one summary row is the minimum
the column may leave. Symmetrically, the dock band's *open* height is `shrink`-able down to
`min-h-24` (§4.6): the 60dvh is an ask, not a demand, and the pressure lands on the largest
panel instead of the one with no floor.

`overflow-hidden` is already on the root, so collapsing is pure clamping: **the list stays
mounted**, scroll position and `useRunSelection`'s refs survive, and the `layoutId`
highlights never replay (no drawer mount/unmount).

**The summary row** — rendered as the root's first child, only when `fold !== undefined`
(i.e. only on mobile; the desktop-guard test keys on its absence). It answers "which run, is
it alive, is it blocked, am I filtered" while folded, and it is a *sibling pair* of buttons
because a button inside a button is not a thing HTML has (the Cast.tsx:88-90 rule):

```tsx
{fold && (
  <div className="flex h-12 shrink-0 items-center gap-2 pr-3">
    <button
      type="button"
      data-testid="rail-band-toggle"
      aria-expanded={!fold.folded}
      onClick={fold.onToggle}
      className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-4 text-left"
    >
      <RadarDot live={selectedRun?.live ?? false} />
      <b className="truncate text-[13px] font-semibold">{selectedRun?.label ?? 'Orchestrators'}</b>
      {selectedRun?.hasOpenGates && (
        <OctagonAlert role="img" aria-label="blocked on an open decision gate" className="text-gate size-4 shrink-0" />
      )}
      {newRunId !== null && (
        <>
          <span aria-hidden className="bg-selection size-1.5 shrink-0 rounded-full" />
          <span className="sr-only">new orchestration started</span>
        </>
      )}
      <span className="text-muted-foreground/70 ml-auto text-[11px] tabular-nums">{runs.length}</span>
      <ChevronDown className={cn('text-muted-foreground size-4 shrink-0 transition-transform', !fold.folded && 'rotate-180')} />
    </button>

    {selectedAgentMember && (
      <button
        type="button"
        data-testid="rail-agent-chip"
        aria-label={`clear the agent filter ${selectedAgentMember.monogram}`}
        onClick={() => onSelectAgent(null)}
        className={cn(CHIP_CLASS, 'shrink-0 cursor-pointer py-1.5')}
      >
        {selectedAgentMember.monogram} <X className="size-3" />
      </button>
    )}
  </div>
)}
```

where `selectedRun = runs.find((run) => run.id === selectedId) ?? null` and
`selectedAgentMember = selectedRun?.cast.find((member) => member.handle === selectedAgent) ??
null`, derived locally. The selection-blue dot re-surfaces the new-run chip's news on the fold
(the chip itself, lines 91-103, sits above the ScrollArea and is clipped while collapsed) —
per SPEC §7.3 it stays a dot, never a navigation — and it wears an `sr-only` text twin (the
`live-dot` pattern of `RunRow`), because while the band is folded the textual chip below is
inert behind the clamp, and a colour-only dot would leave the news unreachable to a screen
reader. The `[A2 ✕]` chip is the escape from agent-dimming that stays reachable while the
canvas is showing — the dimmed canvas is never a dead zone (CANVAS report §2). New imports:
`ChevronDown`, `X` (lucide), `CHIP_CLASS` is already imported, and `CastMember` type if
needed.

**Focus handoff on the fold.** Folding makes `rail-body` inert in the same commit, and a
browser blurs any focus inside a subtree that goes inert (the focus-fixup rule) — so a
keyboard pivot would silently drop its focus to `<body>`. An effect in `RunRail`, run only on
the expanded→folded flip (never on mount, never on a viewport crossing), hands focus to the
band toggle — the chrome that undoes the fold — whenever the fold caught focus inside the
body or had already spilled it to `<body>`.

**The inert wrapper** — everything below the summary row (the existing header, the new-run
chip, the ScrollArea) is wrapped in one div so a collapsed band's clipped rows leave the tab
order:

```tsx
<div
  data-testid="rail-body"
  inert={fold?.folded ? true : undefined}
  aria-hidden={fold?.folded ? true : undefined}
  className="flex min-h-0 flex-1 flex-col"
>
  …header, chip, ScrollArea exactly as today…
</div>
```

On desktop `fold` is undefined, the attributes never apply, and the wrapper reproduces the
root's flex geometry exactly (root: `flex-col`; wrapper: `flex-1 min-h-0 flex-col`; children
keep their `shrink-0` / `flex-1` as today). No test asserts nesting.

**The stranded-hover guard** — module level, the `theme-mode.ts` idiom:

```ts
/**
 * Some mobile browsers fire mouseenter on tap, which would strand the sliding `rail-hover`
 * highlight (one layoutId, line ~184) on the last row a thumb touched. Hover is a pointer
 * fact, not a width fact, so it is checked once: no hover hardware, no hover state.
 */
const CAN_HOVER = globalThis.matchMedia?.('(hover: hover)').matches ?? true;
```

Applied where the state is written: `onMouseEnter={() => { if (CAN_HOVER) onHover(); }}` in
`RunRow` (line 171 today). jsdom has no `matchMedia` → `true` → desktop and all existing
tests unchanged.

**Small touch fixes in this file:** the new-run chip (line 98) gains `max-lg:py-1.5`; the
coordinator CopyButton (line 300) gains `pointer-coarse:size-8`. `Cast.tsx` needs **no
edits** — agent rows are already ≥44px and its copy buttons inherit §4.4.

### 4.8 `src/client/gates/GateStrip.tsx`

- Strip classes (lines 66-69): append `max-lg:max-h-28 max-lg:px-3 max-lg:py-2
  max-lg:landscape:max-h-20`. The question's `flex-[1_1_240px]` (line 165) already wraps at
  360px.
- **Task-less gates become tap-to-expand on mobile.** Today the row (lines 90-93) is a plain
  div and the full multi-paragraph question lives only in a `title` tooltip (line 165) — dead
  on touch. Change: `GateEntry` gains a `clamp` prop (default `true`) that toggles the
  `line-clamp-3` on the `<b>`; the component reads `const isMobile = useIsMobile()` and holds
  `const [expandedId, setExpandedId] = useState<string | null>(null)`; when `isMobile`, the
  task-less branch renders

  ```tsx
  <button
    type="button"
    aria-expanded={expandedId === gate.id}
    onClick={() => setExpandedId((current) => (current === gate.id ? null : gate.id))}
    className="min-w-0 flex-1 cursor-pointer rounded-lg px-1.5 py-1 text-left"
  >
    <GateEntry gate={gate} blocks={null} clamp={expandedId !== gate.id} />
  </button>
  ```

  Desktop keeps the plain div + `title` exactly as today (the branch is `isMobile`-selected,
  and jsdom renders the desktop branch). Expansion is *reading*, not resolving — the strip
  still offers nothing (SPEC §1.2); option pills stay pills, stay non-buttons (canon trap 6).
  Gates *with* a task keep their click-through to the inspector, where the question is already
  un-clamped (`GateQA`).
- The gate-id CopyButton (line 110) becomes visible on touch via §4.4, and it remains the only
  place a task-less gate's id is reachable — now actually reachable.

### 4.9 `src/client/canvas/Canvas.tsx`

- `<MiniMap …>` (lines 162-169) gains `className="max-lg:hidden"` — the most expendable chrome
  at phone size. It stays mounted in jsdom (class hiding), so no existing test moves.
- Isolated-tasks toggle (line 190): `h-7` gains `max-lg:h-10`.
- Edgeless note chip (line 176): gains `max-lg:mt-11` so it stacks below the isolated toggle
  instead of colliding with it at 360px. The legend chip's `<Panel>` gains `max-lg:hidden`:
  with a band open the canvas stands at its 96px floor, where a bottom-centre legend sits *on*
  the isolated toggle and the zoom controls rather than under them (found in the 390px
  screenshot pass — a legend worn as a collision explains nothing). Desktop keeps it.
- **New prop:** `refitSignal?: number` (default `0`) on `CanvasProps`.
- **New component `Refit`**, rendered inside `<ReactFlow>` beside `CentreOnSelection` (same
  "needs viewport context" rationale, line 171):

  ```tsx
  /**
   * The two moments the folded shell is allowed to re-frame the graph — and only these two,
   * because "the viewport the user framed is theirs" (CentreOnSelection, below) is doctrine:
   *
   * - **Rotation.** Turning the phone is the reader's own gesture; re-fitting on it is not a
   *   yank (SPEC §7.3), it is answering the question the gesture asked.
   * - **The dock band collapsing after a cross-run hop** (`refitSignal`). The new run's fit
   *   ran while the band held 60dvh of the column; collapsing it should land on a freshly
   *   framed graph, not a mid-layout one.
   *
   * Both defer one frame so React Flow's own ResizeObserver has measured the resized
   * container first, and both stand down while a task is selected — a selection is centred,
   * and a fit that zoomed away from it would trade the reader's place for a tidier frame.
   */
  function Refit({ signal, selectedTaskId }: { signal: number; selectedTaskId: string | null }) { … }
  ```

  Behavior: `const isMobile = useIsMobile()`; an effect subscribes to
  `globalThis.matchMedia?.('(orientation: portrait)')` `change` events while `isMobile`; on
  flip or on a `signal` increment (tracked against a ref of the last-seen value), and only when
  `selectedTaskId === null`, call `requestAnimationFrame(() => flow.fitView({ padding: 0.2,
  maxZoom: 1 }))` — the exact `fitViewOptions` of line 151. Band expand/collapse otherwise
  never re-fits.
- **`CentreOnSelection` zero-size guard** (the one graft *inside* this locked-adjacent
  machinery): add `const sized = useStore((state) => state.width > 0 && state.height > 0);`
  (`useStore` from `@xyflow/react`), include `sized` in the effect deps, and early-return
  **before** `centred.current = selectedTaskId` when `!sized` — a selection made while the
  canvas measures 0 still centres once the canvas regains height. Desktop never measures 0, so
  this is inert there; jsdom's shimmed geometry reports 1200×800, so existing tests are
  untouched.
- **`CentreOnSelection` defers two frames on the fold.** The tap that selects a node opens the
  dock band in the same commit, and `setCenter` reads width/height from React Flow's store —
  which its ResizeObserver refreshes only during the next frame's rendering steps, *after* the
  selection effect runs. Centring immediately would aim for the middle of the pre-tap canvas
  and park the node under the band. So on mobile the `setCenter` call (and the `centred`
  claim with it) rides a double `requestAnimationFrame`, landing after the observer has
  reported the shrunken height; the effect's cleanup cancels and a re-render in the gap
  reschedules, so a selection is still centred exactly once. Desktop keeps the synchronous
  call — nothing about its geometry moves on a selection (§8 rule 3).
- Nothing else: nodes, `NODE_WIDTH`/`NODE_HEIGHT` (`theme.ts:20-21`), dim variants, pulses,
  selection ring, `LAYOUT_OPTIONS`, `fitViewOptions` are locked/sign-off territory and all work
  at phone width already. Waves march left-to-right in portrait too — accepted (§11).

### 4.10 `src/client/conversation/Conversation.tsx` + `src/client/components/ui/scroll-area.tsx`

**ScrollArea** gains two optional pass-throughs to the Radix Viewport (additive; every existing
call site compiles and renders unchanged):

```tsx
function ScrollArea({ className, children, viewportRef, onViewportScroll, ...props }:
  React.ComponentProps<typeof ScrollAreaPrimitive.Root> & {
    /** The scrolling element itself, for callers that need to read or set its position. */
    viewportRef?: React.Ref<HTMLDivElement>;
    onViewportScroll?: React.UIEventHandler<HTMLDivElement>;
  }) { … <ScrollAreaPrimitive.Viewport ref={viewportRef} onScroll={onViewportScroll} … /> … }
```

(The `[&>div]:!block` patch at line 29 is load-bearing for every `truncate` in the dock —
untouched.)

**Conversation:**

- Entrance: `variants={isMobile ? BAND_IN : DOCK_IN}` on the aside (line 86), with
  `const isMobile = useIsMobile()`.
- Tap targets: `ScopeButton` (line 279) gains `max-lg:py-2`; the "show all" button (line 206)
  gains `max-lg:px-3 max-lg:py-1.5`.
- **The "new exchanges" chip** — closes the no-auto-scroll gap, mobile-only so desktop stays
  byte-identical, in the new-run chip's exact grammar (news you may tap, never a navigation
  performed for you):
  - Wrap the ScrollArea (line 117) in `<div className="relative flex min-h-0 flex-1
    flex-col">`; pass `viewportRef` and `onViewportScroll` down.
  - State: `const [unseen, setUnseen] = useState(false)`; refs track the previous last turn
    id **and the previous scope identity** (`scope` · `run?.id` · `selectedAgent`). An effect
    on both: when the last id changes *within an unchanged scope* and the viewport is scrolled
    more than 48px from the bottom (`scrollHeight - scrollTop - clientHeight > 48`),
    `setUnseen(true)`; a move that changed the scope retires the chip instead — a re-scope
    re-derives `shown` from the same turns and moves the last id without anything having
    arrived, and the chip is arrival news, never a side effect of the reader's own filter.
    `onViewportScroll`: when within 48px of the bottom, `setUnseen(false)`.
  - Render, when `isMobile && unseen`:

    ```tsx
    <button
      type="button"
      data-testid="new-turns-chip"
      onClick={() => viewport?.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })}
      className={cn(CHIP_CLASS, 'absolute bottom-2 left-1/2 z-10 -translate-x-1/2 cursor-pointer py-1 shadow-lift-2')}
    >
      <ArrowDown className="size-3" />
      new exchanges below
    </button>
    ```

    The click handler asks `matchMedia('(prefers-reduced-motion: reduce)')` and passes
    `behavior: 'auto'` when it matches — an explicit `'smooth'` ignores the CSS
    `scroll-behavior` property (CSSOM consults the property only when the call says `'auto'`),
    so the reduced-motion rule at `index.css:477-486` cannot flatten this scroll by itself.
    New imports: `ArrowDown`, `CHIP_CLASS`, `BAND_IN`, `useIsMobile`, `useEffect`/`useRef`.
- `TurnRow.tsx` needs **no edits**: bubbles are full-width block buttons (the one thumb-sized
  target the dock already had), bodies are `wrap-anywhere`, and heartbeats are one pill.

### 4.11 `src/client/inspector/Inspector.tsx`

- Entrance: `variants={isMobile ? BAND_IN : DOCK_IN}` on the aside (line 124), with
  `const isMobile = useIsMobile()`.
- **New optional prop** on `InspectorProps`:

  ```ts
  /**
   * The run the reader was standing in when a gate, dep chip or turn followed a task across
   * into this one (`App.showTask`) — mobile-only narration, because on the folded shell the
   * rail's moving `aria-current` is behind a collapsed band and a silent run-hop reads as the
   * canvas replacing itself for no reason. Null (the default, and always on desktop) renders
   * nothing.
   */
  hoppedFrom?: string | null;
  ```

  Rendered by `Header` between the title row and the chip row (after line 265):

  ```tsx
  {hoppedFrom && (
    <p data-testid="cross-run-note" className="text-muted-foreground relative truncate font-mono text-[10px]">
      followed here from {hoppedFrom}
    </p>
  )}
  ```

- Close X (line 261): `size-7` gains `max-lg:size-10`.
- Spec/Result `<pre>` (line 307): `max-h-56 overflow-y-auto` gains `max-lg:max-h-none` — the
  nested touch-scroll trap dies; on mobile the panel's single outer ScrollArea (its stated
  philosophy, lines 132-134) does all the scrolling.
- Dep chips (line 573): add `max-lg:py-1.5`. GateQA option pills (line 504): `py-px` gains
  `max-lg:py-1`. The two `size-5` CopyButtons (lines 412, 495): add `pointer-coarse:size-8`.

---

## 5. The gestures, end to end on mobile

**Select a run.** Tap the rail band → it expands in place to 45dvh (the canvas shrinks beneath,
still visible). Tap a run row → `selectRun` fires exactly as today: agent and task selections
clear (App.tsx:153-157), the canvas re-lays-out behind the expanded rail, the cast unfolds
*inside* the rail under the tapped row (the containment is canon, trap 10). The rail **stays
open** — the cast you just revealed is the next thing you will touch. Tap the band header (or
an agent) to fold it and see the new canvas.

**Select an agent — the pivot.** In the expanded cast, tap `A2` → `setSelectedAgent` fires and
the rail auto-folds (mobile-only rule). One tap, three visible effects in sequence: the fold
reveals a canvas already dimmed to A2's tasks at 18% (the motion-variant dim, untouched), the
folded rail header now wears the `[A2 ✕]` chip, and the dock — folded or expanded — holds A2's
half of the dialogue (the handle's exchange count re-scopes too). **The way out is everywhere
the state is shown**: re-tap A2 in the reopened cast (the Cast.tsx:96 toggle), tap ✕ on the
rail-band chip, or "show all" in the Conversation header — all funnel to
`setSelectedAgent(null)`. The dimmed canvas is never a dead zone.

**Tap a node.** Nodes are 240×84 tap targets. `onNodeClick` → `selectTask` toggles as today;
on mobile it also opens the dock band, which rises to 60dvh already swapped to the Inspector
(`BAND_IN` plays; exits stay instant). `CentreOnSelection` centres the node in the *shrunken*
canvas — correct, because bands push rather than overlay, so the visible canvas is the real
viewport. Exits stay plural and equivalent: the upsized X, or re-tap the node peeking above the
band — both `setSelectedTaskId(null)`, and the Conversation returns in the same band at the
same height.

**A gate opens.** The selected run gains an open gate → GateStrip mounts above the canvas,
aurora drifting, unprompted, whatever the bands are doing — impossible to miss because it takes
height directly from the canvas, exactly the desktop economics. Tap a gate row → `showTask` →
run-hop if needed, agent clears, canvas re-scopes, dock band expands to the Inspector showing
the un-clamped question — and the inspector's header says `followed here from …` so the hop is
legible with the rail folded. A task-less gate expands in place to show its full question, and
its copy button is now visible.

**A turn names a task.** In the expanded dock, tap a bubble → `showTask` → the band content
swaps Conversation → Inspector in place; the canvas above shows the ring and centres. Dep chips
keep hopping tasks — the band content just changes.

---

## 6. React Flow on touch

The core move already answers the hard question: **the page never scrolls on any form factor**,
so there is nothing behind the canvas for a pan to trap. One-finger drag pans, pinch zooms
(`zoomOnPinch` default), `preventScrolling`'s default `preventDefault` is exactly right.
`zoomOnDoubleClick` stays default — no double-tap idiom is introduced for it to fight.

The canvas is **never `display: none`** (bands push it; `max-lg:min-h-24` floors it), so React
Flow never initializes or centres against 0×0 — both traps avoided structurally. Cross-run
navigation already re-fits by construction: a run change makes `layout` null
(`Canvas.tsx:100`), the "Laying out N tasks…" state unmounts `<ReactFlow>`, and the remount
runs the initial `fitView` — `Refit` (§4.9) exists only for the two cases that mechanism cannot
see (rotation; a collapse revealing height the fit never had). Dimmed nodes'
`pointer-events-none` is fine because the un-dim affordance lives on the always-visible
rail-band chip. Pinch-to-read is the primary reading gesture at fit-zoom — coherent with "the
initial fit is an overview" (Canvas.tsx:149-151); wave direction and the isolated-grid width
are locked and left alone.

---

## 7. Motion, reduced motion, dark and light

- One new variant (`BAND_IN`), used only as the below-`lg` entrance of the two dock panels,
  always through `enter()` — so `MotionGlobalConfig.skipAnimations` (test/client/setup.ts:22)
  and `<MotionConfig reducedMotion="user">` (App.tsx:190) cover it with no new wiring.
  Collapse is instant. Band height changes are instant (no transition): an expansion is the
  user's own tap, and the arriving *content* is what animates, once.
- No new keyframes, no skeletons, no pull-to-refresh, no tab slides. Ring, radar and aurora
  remain the only living gestures (SPEC §7.9). The `prefers-reduced-motion` block
  (`index.css:477-486`) covers the CSS-driven motion; the chip's scroll is covered in the
  handler itself (§4.10), because an explicit `behavior: 'smooth'` is exempt from the CSS
  `scroll-behavior` property and must ask the media query directly.
- **Dark/light needs no work**: every piece of new chrome is built from existing tokens —
  `PANEL_CLASS`, `PANEL_TITLE_CLASS`, `CHIP_CLASS`, `text-gate`, `bg-selection`,
  `themeOf(status).dot` — all of which already resolve through `:root` / `.dark` variables
  (`index.css`). The theme is class-driven off `<html class="dark">` and never consults a media
  query at render time, so the viewport hook and the theme cannot interact.

---

## 8. What does not change on desktop — five enforcement rules

Each is mechanically checkable in review:

1. **No un-prefixed class is edited.** Every layout change is an appended `max-lg:`,
   `max-lg:landscape:` or `pointer-coarse:` token; at ≥ 64rem with a fine pointer the computed
   style set is identical.
2. **Wrappers are `lg:contents`** (the dock band, its inert body) or geometry-neutral (the rail
   body wrapper reproduces the root's flex chain). The desktop flex row sees the same three
   panel children it sees today.
3. **Behavior changes are `isMobile`-guarded**, and `useIsMobile()` is `false` at ≥ 64rem and
   `false` wherever `matchMedia` is absent. `railOpen`/`dockOpen`/`crossRunFrom` exist on
   desktop but nothing reads them there.
4. **No panel is conditionally mounted by viewport.** The dock swap condition, the GateStrip
   condition and the Notices condition are byte-identical. Only *chrome* (band toggles, the
   dock handle, the two chips) is viewport-conditional — and it is JS-conditional precisely so
   the existing suite never sees it.
5. **Shared constants only gain prefixed tokens** (`DOCK_CLASS`, `COPY_ON_HOVER`,
   `CopyButton`'s base) — the one-string-one-place doctrine now proves the two dock panels
   agree about two widths instead of one.

Verification: the existing 119 tests are the desktop regression net (zero changes expected);
plus a manual pass with the fixture DB (`liveShapeCorpus().write(...)` →
`node dist/server/main.js --db /tmp/orca-viz-demo/orchestration.db --no-open`) at 1280px,
1024px, 390×844, 844×390.

The one honest asterisk: `pointer-coarse:` tokens change what touch-primary **desktop-width**
hardware sees (visible copy buttons, larger icon buttons). Claimed as correct (§2.4), flagged
for sign-off (§11).

---

## 9. Judge grafts — adopted and declined

Adopted (all specified above):

| Graft | Where it landed |
|---|---|
| `inert` + `aria-hidden` on collapsed bands' clipped content | §4.6 dock body, §4.7 rail body |
| `CAN_HOVER` guard on the rail's hover highlight | §4.7 |
| Cross-run hop narration in the Inspector header | §4.6 + §4.11 (`hoppedFrom`, mobile-only) |
| "↓ new" chip when turns append while scrolled up | §4.10 (mobile-only, new-run-chip grammar) |
| Re-fit on dock collapse when the run changed while open | §4.6 (`refitSignal`) + §4.9 (`Refit`) |
| Refit guard conditions (defer a frame; stand down while a task is selected) | §4.9 |
| `CentreOnSelection` zero-size guard | §4.9 |
| Collapsed rail-band summary (label + RadarDot + octagon + `[A2 ✕]` chip) | §4.7 |
| `max-lg:landscape:` compressions | §4.6 TopBar/Notices, §4.8 gate strip |
| Class-string presence tests; standalone `useIsMobile` unit tests; the desktop-guard test | §10 |

Declined, with reasons:

- **Radix-Dialog inspector sheet + drag-to-dismiss.** The fold has no overlay to be modal
  about: the dock is a band that pushes, the canvas above it stays live and tappable, and a
  focus trap would imprison focus away from a working surface. The drag gesture belongs to a
  sheet; a band's toggle is a button with `aria-expanded`, which is the stronger a11y story
  here. (The un-capping of the nested `<pre>` is kept regardless — §4.11.)
- **Explicit centring offset for `CentreOnSelection`.** Unnecessary by construction: bands
  push, so the canvas element *is* the visible strip and `setCenter` already centres in it.
- **`StatusPill` extraction from the TopBar.** There is no second bar to share it with — the
  fold condenses the one `Status` component (App.tsx:327-352) with classes; extraction would
  be motion without work.
- **`bg-panel-solid` + `shadow-lift-3` encoded in `surface.ts` as an overlay constant.** No
  overlay layer exists in this design; the doctrine is recorded as a comment (§4.2) rather
  than as dead code.
- **Fit suppression/debounce beyond `Refit`'s two triggers.** GateStrip mount/unmount and band
  toggling do not re-fit — the viewport the user framed is theirs (Canvas.tsx:285-288).

---

## 10. Test plan

**Existing 119 tests: zero changes, zero expected failures.** No duplicated trees, no new
viewport-conditional panel mounts, the hook resolves desktop in jsdom, `skipAnimations` covers
`BAND_IN`, and every existing testid/ARIA/data-attribute is preserved (new ones are additive:
`rail-band-toggle`, `rail-agent-chip`, `rail-body`, `dock-band-toggle`, `dock-band-body`,
`new-turns-chip`, `cross-run-note`, `aria-expanded` on the two band toggles and the task-less
gate rows).

**New file `test/client/fake-match-media.ts`** — a recording fake in the `FakeEventSource`
mold (live.test.tsx:97-120): constructor records instances per query; `matches` settable;
`dispatchChange()` wraps listener calls in `act()`; installed with
`vi.stubGlobal('matchMedia', …)`, removed with `vi.unstubAllGlobals()` in `afterEach`. It
must answer *any* query (the width query, `(hover: hover)`, `(orientation: portrait)`,
`(prefers-color-scheme: dark)`), each with an independently settable `matches`.

**New file `test/client/viewport.test.tsx`** — the hook in isolation (`renderHook`):

1. With no stub at all, `useIsMobile()` returns `false` — the jsdom-defaults-to-desktop
   contract that protects the other 119 forever (state that sentence in the describe comment).
2. With a stubbed matching MQL it returns `true`; an `act()`-wrapped `dispatchChange` flips it
   live.
3. Unmount removes the `change` listener (the fake records `removeEventListener`).

**New file `test/client/mobile.test.tsx`** — whole-`<App>` renders under the stub, house
voice, SPEC citations in the describe comment; `fireEvent.click` for canvas nodes (the d3-drag
jsdom rule, conversation.test.tsx:163-174), `userEvent` elsewhere; elk reads through the
existing `waitFor` helpers. Roughly twelve tests:

1. **The desktop guard**: with `matchMedia` unstubbed, none of `rail-band-toggle`,
   `dock-band-toggle`, `rail-agent-chip`, `new-turns-chip` are in the document.
2. **Singletons survive the fold**: under the stub, `conversation`, `gate-strip`, `canvas`
   each appear exactly once; `run-row` counts match the fixture (the mobile suite must query
   by testid — the summary row repeats the selected run's *label* text by design).
3. **Rail band**: toggle flips `aria-expanded`; run rows remain in the document either way
   (clamped, never unmounted); `rail-body` carries `inert`/`aria-hidden` exactly while folded.
4. **The pivot**: expanding the rail and tapping an agent folds the band
   (`aria-expanded` false), mounts `rail-agent-chip`; tapping the chip clears `data-dimmed`
   from nodes.
5. **Node → dock**: `fireEvent.click` on a task node mounts `inspector`, unmounts
   `conversation` (the inspector.test.tsx assertions, re-run under the stub), and sets the dock
   toggle's `aria-expanded` true; the handle shows the task title.
6. **Gates**: an open gate renders `gate-strip` while both bands are folded; a task-less gate
   row toggles `aria-expanded` and its question loses/regains `line-clamp-3` (class-presence
   assertion).
7. **Cross-run hop**: the inspector.test.tsx:~670 dep-chip flow under the stub — `aria-current`
   moves on rail rows *and* `cross-run-note` names the run the reader came from; it is absent
   after `selectRun`.
8. **Viewport flip mid-test**: `dispatchChange()` desktop→mobile makes the band chrome appear
   without remounting panels (capture the `conversation` element before the flip; assert the
   same reference — `.toBe()` — after).
9. **Class pins**: `COPY_ON_HOVER` contains `pointer-coarse:opacity-100`; `DOCK_CLASS`
   contains `max-lg:w-full` (theme-import idiom — cheap regression pins for what jsdom cannot
   see).
10. **New-turns chip**: with scroll geometry stubbed on the viewport element
    (`Object.defineProperty` for `scrollTop`/`scrollHeight`/`clientHeight`, plus a `scrollTo`
    stub — jsdom has none), a rerender appending a turn while "scrolled up" mounts
    `new-turns-chip`; clicking it calls `scrollTo`; it is absent when near the bottom.
11. **Rotation wiring**: under the stub, mounting the canvas registers a listener on
    `(orientation: portrait)`; dispatching its change does not throw and does not run while a
    task is selected (assert via the fake's listener bookkeeping — the fitView math itself is
    React Flow's, not ours to test).
12. **Dock handle at rest**: with nothing selected the handle reads `Conversation` and a
    tabular exchange count that excludes heartbeats (same fixture discipline as
    conversation.test.tsx).

**Loop closers**: `npm run typecheck` (strict, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`, `erasableSyntaxOnly`) and `npm run lint` (react-hooks now covers
`viewport.tsx` because it is `.tsx`). Full suite: `npx vitest run --project client` — expect
119 + new, all green.

---

## 11. Accepted risks and the ugliest edge case

1. **Landscape phone + open gate + schema notice** stacks TopBar + Notices + folded rail +
   gate + folded handle over ~360px of height and pinches the canvas toward its 96px floor —
   past which the column overflows and clips at the bottom (`overflow-hidden` is law at
   `<body>`). Shipped mitigations: the `max-lg:landscape:` tightenings and the
   `min(60dvh, 32rem)` dock clamp. A short enough device still shows an ugly frame — but an
   *honest* one: everything on screen is true, reachable, and the gate still interrupts, which
   is the spec's priority order.
2. **`pointer-coarse:` reaches touch-primary desktops** — copy buttons persistently visible at
   desktop layout on Surface-class hardware. Claimed correct (§2.4); one sentence in the PR
   for sign-off, since "desktop unchanged" was framed per-viewport, not per-pointer.
3. **`title`-only facts remain dead on touch** where no substitute was built: the full DB path
   (App.tsx:360), exact timestamps, dep-chip status. The high-value ones got homes (gate
   questions expand; handles/ids have visible copy buttons; the inspector is the node
   tooltips' touch home). The rest are accepted this pass.
4. **Folded panels keep their full DOM** (`max-h` clamps, no virtualization — none exists
   today). Fine on the 466-message corpus; a pathological DB pays the same render cost desktop
   already pays.
5. **`dvh` is new to the codebase**; pre-15.4 iOS falls back to nothing for those two band
   heights. Audience runs current browsers; revisit with paired `vh` fallbacks only if a
   report arrives.
6. **Elk layouts stay landscape-shaped in portrait** — a 5-wave run at fit-zoom is an overview
   you pinch into. Deliberate: wave direction is spec-locked, and overview-then-zoom is the
   existing philosophy.
7. **The dim + everything-folded resting state** (filtered to A2 yesterday, returning today)
   shows a mostly-ghost canvas whose tell is the small `[A2 ✕]` chip. If usability testing
   shows misses, the escalation is a canvas caption chip — which adds canvas chrome and
   therefore needs canon review first.

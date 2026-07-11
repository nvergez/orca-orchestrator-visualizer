# PROTOTYPE — Orca orchestration DAG rendering (wayfinder issue #6)

**Throwaway code.** Answers one question by construction: *does React Flow
(`@xyflow/react`) + auto-layout (dagre vs elkjs) render the real ~72-task
orchestration DAG legibly — statuses as node colors, `deps` as edges,
`parent_id` hierarchy visible, agent-assignment badges, decision-gate markers?*

**Short answer: yes.** Both engines produce a legible graph at real scale. The
real bottleneck isn't the layered layout — it's that the real data is mostly
*disconnected* (72 tasks, only 19 dep edges, ~50 fully isolated nodes), so how
an engine handles disconnected components decides legibility. elkjs handles
that natively; dagre needs ~30 lines of custom packing.

## Run it

```sh
cd prototype
npm install
npm run snapshot   # one-shot READ-ONLY dump of ~/.config/orca/orchestration.db → snapshot.json
                   # (optional — a snapshot from a live run is already committed)
npm run dev        # then open http://localhost:5173
```

- `npm run snapshot [path-to-db]` uses Node 22's built-in `node:sqlite` with
  `{ readOnly: true }`. It never writes to the DB.
- The app renders from `snapshot.json` only — no live connection.

## What's on screen

- **Task nodes** colored by status (pending / ready / dispatched / completed /
  failed / blocked), title clamped to 3 lines, full title on hover.
- **Dep edges** from `tasks.deps` (JSON id array), arrowheads, animated when the
  downstream task is `dispatched`.
- **Assignee badges** — dark monospace chip with the first 8 hex chars of
  `dispatch_contexts.assignee_handle` (latest context per task); `✗N` shows the
  failure count when > 0.
- **Decision-gate markers** — orange `⛔ gate` badge on gated tasks.
- **`parent_id` hierarchy** — children render *inside* a dashed group container
  (React Flow `parentId` + a group node laid out as one block).
- **Legend + status counts** top-left, layout controls top-right, minimap,
  zoom/pan.

## Variants & toggles

- **Floating bottom bar / `?variant=dagre|elk`** (also ← → arrow keys):
  switches the layout engine.
- **left-to-right** (`?dir=LR`): rank direction TB vs LR.
- **grid-pack isolated tasks** (`?pack=0` to disable): pulls nodes with no
  edges out of the engine and packs them into a grid below the DAG.
- **synthetic hierarchy + gate demo** (`?synthetic=1`): the real snapshot has
  **zero `parent_id` rows and zero decision gates**, so this injects a clearly
  marked fake parent group (3 children, one gated) to judge those treatments.

## Observations at real scale (72 tasks, 19 edges, ~50 isolated)

Screenshots in `screenshots/` (taken via Orca's embedded browser).

1. **React Flow itself is a non-issue.** 72 custom nodes + minimap render and
   pan/zoom smoothly; no perf work needed at this scale.
2. **The real graph is dependency-sparse.** Most tasks are fire-and-forget
   singletons; only 2–3 connected chains exist (max 2 deps on a task). Layered
   layout quality barely matters at this density — component handling is
   everything.
3. **dagre, naive** (`dagre-nopack.png`): unusable. All isolated nodes land in
   rank 0 → a ~50-node-wide ribbon; fitView zooms out until nothing is
   readable.
4. **dagre + custom grid-packing** (`dagre-tb.png`): legible. ~35ms, sync,
   tiny API. The packing is ~30 lines in `src/layout.js`.
5. **elkjs** (`elk-tb.png`, `elk-nopack.png`): legible *out of the box* —
   `elk.separateConnectedComponents` packs singleton components into a compact
   block automatically. ~120–150ms (async, imperceptible one-shot). Bundled
   build adds ~1.4MB pre-gzip (the build-size warning is elk).
6. **Edge crossings / label overlap**: none worth mentioning at this density in
   either engine. Titles at 3-line clamp are readable at fit-view zoom on the
   connected DAG; the isolated grid needs a little zoom-in to read titles —
   fine.
7. **Hierarchy + gates are unexercised by real data.** The visual treatment
   (dashed containment, ⛔ badge) is judgeable only via the synthetic toggle
   (`elk-synthetic.png`). Group-in-layout is simplistic here (group = one big
   node, children in a row); elk supports true compound layout if real
   `parent_id` data shows up and nesting gets deep.

## Layout-engine verdict (proposed, for the dev to react to)

**Pick elkjs.** Its native disconnected-component packing matches the actual
shape of orchestration data (mostly singletons + a few chains), and its
compound layout is the escape hatch when `parent_id` hierarchies appear. Cost:
async API + ~1.4MB bundle — irrelevant for a local tool. dagre is the fallback
if bundle size ever matters, but it needs the custom packing kept around.

## Open questions for the dev

1. Is grid-packing isolated tasks below the DAG the right treatment, or should
   isolated/completed tasks be collapsible/hidden by default?
2. Node density: 240×84 nodes with 3-line titles — right tradeoff, or smaller
   nodes + title-on-hover to fit more on screen?
3. Is the synthetic containment treatment for `parent_id` (dashed group box)
   what you want, or would a hierarchy toggle/indent view serve better?
4. TB vs LR as the default rank direction?

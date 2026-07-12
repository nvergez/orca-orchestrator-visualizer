# orca-viz

See what your Orca agents are doing — the task DAG, who is working what, the decision gates
blocking the run, and the messages the agents are sending each other.

```sh
npx orca-viz
```

It finds Orca's orchestration database, starts on `127.0.0.1:4269`, and opens a browser.

## Read this before you point it at your machine

**orca-viz is unofficial and third-party.** It is **not affiliated with, endorsed by, or
supported by Stably or Orca**. It is an outside observer of a database that happens to be
readable.

**It is strictly read-only. It never writes to your database** — not a gate resolution, not a
retry, not marking a message read. Every connection is opened `readOnly: true`, and there is
no code path in the tool that issues a write. That is what makes it safe to run against a
live orchestration: Orca's coordinator assumes it is the single writer, and orca-viz does
nothing to challenge that assumption.

**It reads Orca's internal, undocumented schema.** That schema is Orca's private business, it
carries no compatibility promise to anyone outside the app, and it changes between Orca
releases. So **a minor bump of orca-viz may be required after an Orca update.** This is an
expectation, not an apology — see [Compatibility](#compatibility) for exactly which Orca
schema each release was verified against, and [Surviving an Orca
update](#surviving-an-orca-update) for what happens when you get ahead of the table.

It binds to loopback only. Your task specs, agent prompts and message bodies are in that
database, and they are not served to the network.

## Requirements

**Node >= 22.5.** That is where `node:sqlite` landed, and `node:sqlite` is why orca-viz has
**zero native dependencies and no install script**: nothing compiles on first run, so `npx`
starts the tool in seconds instead of failing on a native build. orca-viz checks the version
itself at startup and tells you what to do, because npm's own `engines` warning is easy to
miss and the alternative failure is a cryptic `Cannot find module 'node:sqlite'`.

You also need Orca, with orchestration enabled (it is experimental, behind the localStorage
flag `orca.orchestration.enabled`), and at least one orchestration run in its history.

## Usage

```sh
npx orca-viz                      # find the database, serve it, open a browser
npx orca-viz --list-dbs           # every database it can find, and which it would choose
npx orca-viz --db ./copy.db       # read a specific database — a copy, a backup, a colleague's
npx orca-viz --port 8080 --no-open
```

| Flag | |
|---|---|
| `--db <path>` | The `orchestration.db` to read. A path that does not work is a **hard error** — orca-viz will never quietly fall back to a different database than the one you named. Also settable as `ORCA_VIZ_DB`. |
| `--list-dbs` | Print every candidate database, in the order orca-viz would choose them, with its liveness, schema version and mtime. Then exit. |
| `--port <n>` | Port to listen on (default `4269`). A port that is already taken is an error, **not** a hop to another one — a hunted port would break the URL orca-viz just opened and any bookmark of it. |
| `--host <host>` | Address to bind (default `127.0.0.1`). Loopback by design; see the warning above before changing it. |
| `--poll-interval <ms>` | How often to re-read the database (default `5000`). |
| `--no-open` | Do not open a browser. Also suppressed automatically when stdout is not a terminal, or over SSH, or with no display — so it does the right thing on a headless box without being told. |
| `--version` | Print the version and exit. |
| `--help` | Print the flags and exit. |

### Where it looks for the database

First hit wins, and every candidate is validated before it is accepted — the file exists,
SQLite can actually open it read-only, and its `PRAGMA user_version` reads:

1. `--db`
2. `ORCA_VIZ_DB`
3. `$ORCA_USER_DATA_PATH/orchestration.db`
4. The platform defaults, mirroring Orca's own `userData` directory:

   | | |
   |---|---|
   | Linux | `${XDG_CONFIG_HOME:-~/.config}/orca` |
   | macOS | `~/Library/Application Support/orca` |
   | Windows | `%APPDATA%\orca` |

   each with an `orca-dev` sibling for dev builds. When more than one exists, orca-viz prefers
   the one with a fresh `orca-runtime.json` — the Orca you are actually using — and tiebreaks
   on the most recent write.

The chosen path is always printed at startup. You should never have to wonder which database
you are looking at.

**Local disks only.** The database is in WAL mode, and WAL does not work over a network
filesystem. Pointing `--db` at NFS, SMB, sshfs, or `/mnt/c` from WSL is refused with an
explanation rather than silently misread.

## What it shows

```
┌──────────────┬──────────────────────────────────────────────┬─────────────────────┐
│  RUN RAIL    │  ⚠ GATE STRIP (only when gates are open)      │   RIGHT DOCK        │
│  (inferred)  ├──────────────────────────────────────────────┤   • MESSAGE FEED    │
│              │                                              │       ⇕             │
│  ● run label │              DAG CANVAS                      │   • NODE INSPECTOR  │
│    date·N·⛔ │           (exactly one run)                   │     (on selection)  │
└──────────────┴──────────────────────────────────────────────┴─────────────────────┘
```

- **The canvas** — one node per task, coloured by status, labelled with its title, with the
  assignee's handle, a "last seen 12s ago" badge while it is dispatched, a failure count, and
  a retry marker. Dependency edges animate into whatever is currently dispatched.
- **The run rail** — your tasks grouped into runs, most recent selected. History is free: a
  run from four days ago renders through exactly the same code path as the live one. There is
  no history mode.
- **The gate strip** — the questions actually blocking your orchestration, above the canvas
  rather than in a tab you forget to open. It disappears when nothing is blocked.
- **The feed** — what the agents are saying to each other, live over SSE, heartbeat-free by
  default (heartbeats are ~65% of the traffic), and linked both ways with the canvas: click a
  message to find its task, click a task to read its story.
- **The inspector** — the spec that was dispatched, the result that came back, and **every**
  dispatch attempt, which is the only place the retry-and-circuit-breaker story is visible.

It follows your system's light or dark theme, and the toggle in the top right overrides that and
is remembered.

## What it infers, and where that can be wrong

orca-viz reads a database that was designed for a coordinator, not for a viewer, and it is
honest about the difference.

- **Runs are inferred, and the UI says so.** The schema has no run id. orca-viz groups tasks
  by the terminal handle that created them, then splits a handle's tasks on an idle gap of
  more than **6 hours**. Tasks with no handle collect into one *Unattributed* run rather than
  vanishing. A genuinely long overnight pause can therefore split one run in two
  ([#28](https://github.com/nvergez/orca-orchestrator-visualizer/issues/28) tracks the gap
  threshold); two runs are never merged just because they overlapped in time.
- **Gates come from `decision_gate` messages, not the `decision_gates` table** — which is
  empty in practice. A gate is open until a reply threads onto it.
- **Status transitions are not recorded anywhere.** Only creation, each dispatch attempt, and
  completion carry a timestamp, so orca-viz shows you those and does not draw a status
  timeline that would be a fabrication.
- **A re-completed task overwrites its first completion time** (the schema does this, not
  orca-viz), so "completed at" is the latest completion, never the first.
- **The database is never pruned**, and `orca orchestration reset` deletes rows without
  renumbering. orca-viz detects a reset and says so, and a message that points at a task the
  reset deleted still appears in the feed — just unlinked.

## When Orca is closed

It keeps working. Liveness is re-derived every tick from Orca's `orca-runtime.json` and the
process table, so the moment Orca goes away the badge flips to **stale** and the page says
*"Orca isn't running; showing last-known state from &lt;time&gt;"*. The canvas, rail, feed and
inspector all keep rendering — reading yesterday's run is the whole point, and being told
plainly that it is yesterday's run is what makes it trustworthy.

## Surviving an Orca update

orca-viz never refuses to start over a schema it does not recognise, and it never crashes on
one. At startup it reads `PRAGMA user_version` and then introspects the columns that actually
exist, and builds its queries from those:

| What it finds | What you get |
|---|---|
| The schema it was built for | Everything. |
| A **newer** Orca | Everything renders, under a banner: *some data may be missing or mislabeled.* |
| An **older** Orca | Per-feature degradation. A missing column disables exactly the feature that needed it — you lose a badge, not the tool — and the banner names what you lost. |
| The right version number, but a column it expected is gone | The same per-feature degradation, under its own banner: *this Orca is missing columns this build expects.* The columns are the fact; the version number is only a claim. |
| A status or message type it has never seen | Rendered in a neutral style with its raw name. Never dropped. |
| No readable task table at all | This, and only this, is a hard error. |

## Compatibility

Hand-maintained: each release records the Orca schema it was actually verified against.
orca-viz is on its own semver and tracks no Orca version number.

| orca-viz | Orca `SCHEMA_VERSION` verified against | Orca app version |
|---|---|---|
| 0.2.x | 5 | 1.4.128 |
| 0.1.x | 5 | 1.4.128 |

If your Orca is newer than the last row, orca-viz will most likely still work — the schema's
history so far is purely additive — and the banner will tell you that you are past what was
verified. If something is genuinely missing, that is a bug worth filing.

## Development

```sh
npm ci
npm test          # vitest: the HTTP API against real fixture databases, and the UI in jsdom
npm run typecheck
npm run lint
npm run build     # dist/client (Vite) + dist/server (tsc) — what the package ships
npm start         # run the built server
```

Tests never mock the database driver: they build a real `orchestration.db` with the fixture
builder and drive the real server over real HTTP. The fixtures reproduce the *shape* of a live
database — gate messages with no gate rows, split timestamp formats, null handles, orphaned
task ids — because a fixture that is tidier than reality certifies exactly the bugs this tool
was written to avoid.

### Releasing

A release is a pull request labelled `release`. package.json is the source of truth for the
version, so the bump is a reviewable line in the diff and not something CI decides on its own:

1. Bump `version` in `package.json` in the PR.
2. Add the row for it to the [compatibility table](#compatibility) — the packaging test fails
   until the table has a row for the new `major.minor`.
3. Label the PR `release`. CI now also checks that the version is one npm does not already have,
   so a forgotten bump fails on the PR rather than after the merge.
4. Merge. The [release workflow](.github/workflows/release.yml) re-runs the full check suite on
   the merge commit, publishes to npm, pushes the `v<version>` tag, and cuts a GitHub Release
   with generated notes.

There is no npm token anywhere in this repo. The workflow authenticates to npm with
[trusted publishing](https://docs.npmjs.com/trusted-publishers): npm is configured to trust this
repo's `release.yml`, GitHub mints a short-lived OIDC token for the job, and npm exchanges it for
publish rights. Every published version therefore carries a signed provenance attestation linking
it back to the commit it was built from.

Merging without the label publishes nothing. A `release` label on a PR that did not bump the
version publishes nothing either, and says so on the run.

## License

[MIT](LICENSE). Copyright (c) 2026 Nicolas Vergez.

Orca is a product of Stably. This project is not affiliated with them, and the name is used
only to say what the tool reads.

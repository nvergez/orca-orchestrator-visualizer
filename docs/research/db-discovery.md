# Cross-platform discovery of Orca's `orchestration.db`

Research for issue #3. Sources: Orca source (read-only checkout at `/home/dev/projects/orca`, cited as `file:line`), the shipped Linux package (v1.4.128, `/opt/Orca`), Electron docs, SQLite WAL docs, and live verification on this Linux machine.

## TL;DR

Orca puts `orchestration.db` directly inside Electron's `userData` directory, and — decisively — the **packaged app's `package.json` has `"name": "orca"` (lowercase) and no `productName`**, so `userData` resolves with the lowercase name on every platform:

| Variant | Linux | macOS | Windows |
|---|---|---|---|
| Packaged Orca | `${XDG_CONFIG_HOME:-~/.config}/orca/orchestration.db` ✅ verified live | `~/Library/Application Support/orca/orchestration.db` | `%APPDATA%\orca\orchestration.db` |
| Dev (`pnpm dev` / orca-dev) | `${XDG_CONFIG_HOME:-~/.config}/orca-dev/orchestration.db` | `~/Library/Application Support/orca-dev/orchestration.db` | `%APPDATA%\orca-dev\orchestration.db` |

There is **no user-facing config override** of this location in packaged builds. The only overrides are dev/test-only (`ORCA_DEV_USER_DATA_PATH`, E2E harness). The env var `ORCA_USER_DATA_PATH` is *exported by* Orca into its child processes and honored by Orca's own CLI as an instance selector — the visualizer should honor it the same way. A sibling file `orca-runtime.json` marks a directory as a real, recently-live Orca instance.

---

## 1. How Orca itself resolves the DB path

The path is built in exactly one place, lazily, as `userData + '/orchestration.db'`:

```ts
// src/main/runtime/orca-runtime.ts:2892-2898
getOrchestrationDb(): OrchestrationDb {
  if (!this._orchestrationDb) {
    const { app } = require('electron')
    const dbPath = join(app.getPath('userData'), 'orchestration.db')
    this._orchestrationDb = new OrchestrationDb(dbPath)
  }
  ...
```

So everything reduces to: *what does `app.getPath('userData')` resolve to?*

Per the Electron docs ([app.getPath](https://www.electronjs.org/docs/latest/api/app#appgetpathname)), `userData` defaults to the `appData` directory appended with the app's name, where `appData` is:

- Windows: `%APPDATA%` (Roaming)
- macOS: `~/Library/Application Support`
- Linux: `$XDG_CONFIG_HOME` or `~/.config`

and the app's name comes from `package.json` (`productName` preferred over `name` when present).

### Why the name is lowercase `orca` on all platforms

Extracted from the actual shipping app (`/opt/Orca/resources/app.asar`, v1.4.128): the packaged `package.json` contains `"name": "orca"` and **no `productName` field**. `productName: 'Orca'` exists only in the electron-builder config (`config/electron-builder.config.cjs:51`), which names install artifacts (`/opt/Orca`, `Orca.app`, `Orca.exe` via `executableName`, `config/electron-builder.config.cjs:175`) but is not injected into the runtime `package.json`. So at Electron startup `app.name = 'orca'` and `userData = appData + '/orca'`.

Orca does call `app.setName('Orca')` — but only inside `whenReady` (`src/main/index.ts:1596`), after Chromium has already initialized the profile directory; Orca's own code comments treat the pre-`setName` lowercase path as the canonical one and go out of their way to capture it early (`src/main/persistence.ts:316-334`, `src/main/index.ts:579-586`). Empirically on this packaged Linux install, even the lazily-resolved orchestration DB lands in the lowercase dir:

```
-rw-r--r-- 1 dev dev  524288 ~/.config/orca/orchestration.db
-rw-r--r-- 1 dev dev   32768 ~/.config/orca/orchestration.db-shm
-rw-r--r-- 1 dev dev 4140632 ~/.config/orca/orchestration.db-wal
```

(`~/.config/Orca` does not exist.) On macOS and Windows the filesystem is case-insensitive by default, so the casing question is moot there — but the created directory name is lowercase.

### The authoritative cross-check: Orca's own CLI

Orca's bundled CLI must find the same directory from *outside* Electron, and it hard-codes exactly the table above — this is the strongest possible confirmation of the per-platform paths (`src/cli/runtime/metadata.ts:41-70`):

```ts
export function getDefaultUserDataPath(platform, homeDir = homedir()): string {
  if (process.env.ORCA_USER_DATA_PATH) return process.env.ORCA_USER_DATA_PATH
  if (platform === 'darwin') return join(homeDir, 'Library', 'Application Support', 'orca')
  if (platform === 'win32')  return join(process.env.APPDATA, 'orca')   // throws if APPDATA unset
  return join(process.env.XDG_CONFIG_HOME || join(homeDir, '.config'), 'orca')
}
```

The visualizer can simply mirror this function.

## 2. The `orca-dev` variant

In dev mode (`pnpm dev`), before anything touches `userData`, Orca redirects it (`src/main/startup/configure-process.ts:178-206`):

1. E2E test config `userDataDir` → `app.setPath('userData', e2eConfig.userDataDir)` (line 186) — test-only, arbitrary temp dirs.
2. `ORCA_DEV_USER_DATA_PATH` env var → `app.setPath('userData', overrideUserDataPath)` (line 198) — **dev-mode only**; used for isolated repro instances.
3. Otherwise → `app.setPath('userData', join(app.getPath('appData'), 'orca-dev'))` (line 205). Same base dir, sibling folder named `orca-dev`.

Because `setPath` is explicit, the later `setName` is irrelevant in dev. Note the *dev instance identity* machinery (`src/main/startup/dev-instance-identity.ts`, driven by `ORCA_DEV_BRANCH` / `ORCA_DEV_WORKTREE_NAME` / `ORCA_DEV_INSTANCE_LABEL`) changes only the window title and AppUserModelId — **not** the userData path. All dev instances share `orca-dev` unless `ORCA_DEV_USER_DATA_PATH` says otherwise.

## 3. Overrides, profiles, multiple instances → how many DBs can exist?

- **Packaged builds have no override.** The only `app.setPath('userData', …)` calls in the codebase are the dev/E2E ones above; packaged runs always use the platform default. `orca serve` (headless, how this machine runs Orca via systemd) is a packaged run and uses the same path — verified: this machine's serve instance writes `~/.config/orca/orchestration.db`.
- **`ORCA_USER_DATA_PATH` is an output of the app and an input to the CLI.** The main process canonicalizes it to its own userData at startup (`src/main/startup/configure-process.ts:208-213`) and exports it into every PTY/child it spawns (`src/main/ipc/pty.ts:981`, `src/main/cli/cli-installer.ts:896`); the CLI reads it first (`src/cli/runtime/metadata.ts:50-52`) so `orca` commands inside a dev instance target that instance. A standalone tool should honor it with the same semantics: *if set, that userData dir wins over platform defaults.* (It is not reliably present in every Orca-spawned shell — it was absent in this worker's terminal — so treat it as a hint, not a requirement.)
- **Orca profiles do NOT multiply the DB.** Profiles store their state under `<userData>/profiles/<profileId>/orca-data.json` (`src/main/orca-profiles/profile-storage-paths.ts:30-46`), but `orchestration.db` is joined to the userData *root* (`orca-runtime.ts:2894`) — one orchestration DB shared by all profiles of an install.
- **One live instance per userData dir.** Electron's single-instance lock is keyed on the userData path (`src/main/startup/single-instance-lock.ts:24-28`), so packaged + dev can run simultaneously (two DBs), but two packaged instances cannot share one dir.
- **So the realistic DB population on one machine is:** `orca/orchestration.db` (packaged), `orca-dev/orchestration.db` (dev builds), plus rare arbitrary dirs from `ORCA_DEV_USER_DATA_PATH`/E2E — and all of that once **per OS user** (each user has their own home/appData).
- **Liveness/validity marker:** a real instance dir contains `orca-runtime.json` (`src/shared/runtime-bootstrap.ts:45-47`) with the RPC endpoint + auth token of the running app; Orca's CLI uses it for discovery. Its presence (and freshness) is a good tiebreaker between candidate dirs.

## 4. WAL caveats for read-only opens

Orca opens the DB with `journal_mode = WAL`, `synchronous = NORMAL`, `busy_timeout = 5000` (`src/main/runtime/orchestration/db.ts:51-53`), via Node's built-in `node:sqlite` `DatabaseSync` (`src/main/sqlite/sync-database.ts:2,31-35`). External read-only access while Orca writes is verified working (see HANDOFF.md). Caveats, per [sqlite.org/wal.html](https://www.sqlite.org/wal.html):

1. **SQLite ≥ 3.22.0 is required to open a WAL DB read-only at all**, and one of these must hold: (a) the `-shm` and `-wal` files already exist and are readable, (b) the reader has write permission on the containing directory (so it can create them), or (c) the connection uses the `immutable=1` URI parameter ([§ Read-Only Databases](https://www.sqlite.org/wal.html#read_only_databases)). Any Node ≥ 18 / better-sqlite3 build satisfies the version floor.
2. **Same-user access (the normal case) just works.** While Orca runs, `-wal`/`-shm` exist with mode `0644` (verified above), and the same user has directory write access anyway. A `readOnly: true` open participates in the shared-memory reader index without modifying the DB image.
3. **DB owned by another user is effectively inaccessible on Linux** — not because of SQLite, but because Electron creates `userData` as `0700` (`drwx------` verified on `~/.config/orca`), so other users cannot even traverse into the directory. Don't design for cross-user reads; run the visualizer as the Orca user.
4. **After a clean Orca shutdown the `-wal`/`-shm` files are deleted.** A read-only open then needs directory write permission to recreate them (condition (b)) — fine for the same user; a true no-write-anywhere reader would need `file:...?immutable=1`. Only use `immutable=1` when Orca is definitely not running: it tells SQLite the file *cannot* change, and reads become corrupt if it does.
5. **Never copy the `.db` file alone** for snapshots: "The WAL file is part of the persistent state of the database and should be kept with the database if the database is copied or moved." The live `-wal` here is 4 MB vs a 512 KB main file — most recent state may live only in the WAL until checkpoint.
6. **Network filesystems are unsupported:** "All processes using a database must be on the same host computer; WAL does not work over a network filesystem." The visualizer's DB-reading process must run on the Orca host and serve browsers over HTTP/WS — do not point it at an NFS/SMB/9p mount (this includes reading a Windows Orca DB from WSL via `/mnt/c`, or a remote `orca serve` host's DB over sshfs).
7. Minor: give the reader its own `busy_timeout` (a few seconds). WAL readers don't block the writer or vice versa, but brief locks exist around checkpoint/recovery windows.

## 5. Recommended discovery algorithm (for the spec)

Resolution order — first hit wins; every candidate must pass validation before being accepted:

1. **`--db <path>`** CLI flag (explicit; hard error if unusable — never fall through).
2. **`ORCA_VIZ_DB`** (tool-specific env var; same semantics as the flag).
3. **`$ORCA_USER_DATA_PATH/orchestration.db`** — set by Orca in shells/processes it spawns; matches Orca CLI behavior, automatically targets dev instances.
4. **Platform defaults**, in order (userData dir → append `orchestration.db`):
   - Linux: `${XDG_CONFIG_HOME:-$HOME/.config}/orca`, then `.../orca-dev`
   - macOS: `~/Library/Application Support/orca`, then `.../orca-dev`
   - Windows: `%APPDATA%\orca`, then `%APPDATA%\orca-dev`
5. **If several candidates exist** (e.g. packaged + dev): prefer the dir containing a fresh `orca-runtime.json` (live-instance marker); tiebreak by most recent `mtime` of `orchestration.db`/`-wal`. Log which DB was chosen and provide `--list` to print all candidates.

Validation per candidate: file exists and is readable → open with `readOnly: true` → `PRAGMA user_version` should equal 5 (current `SCHEMA_VERSION`, `db.ts:44`); if it differs, warn and degrade gracefully rather than refuse (the schema is internal to Orca and unversioned as a public API).

Operational rules from §4: run on the same host as Orca, as the same user; never open read-write; never use `immutable=1` against a possibly-running Orca; treat `-wal`/`-shm` as part of the DB.

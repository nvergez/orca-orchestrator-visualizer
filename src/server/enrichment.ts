import { execFile } from 'node:child_process';
import type {
  EnrichedActivity,
  EnrichedWorker,
  Enrichment,
  EnrichmentState,
  Liveness,
} from '../shared/types.ts';
import type { PushResult, StreamSource } from './stream.ts';

/**
 * Live Orca context (#61 — the live-supervision roadmap #51; its SPEC §13 chapter lands
 * with #65) — the one feature in this tool that is allowed to spawn the `orca` CLI, and
 * everything about how it is allowed to.
 *
 * The database cannot say what an agent is *literally doing right now* — the current tool
 * call, the last assistant message, the worktree it works in. Only `orca worktree ps --json`
 * knows, and it dies with the app (SPEC §2.1). So this adapter is:
 *
 * - **Explicit opt-in.** It exists only behind `--orca-enrichment`; while the flag is off,
 *   this module is never constructed and no Orca command runs, ever.
 * - **Live-only.** A refresh that finds `Meta.liveness !== 'live'` runs no command and says
 *   `suspended`. The CLI would fail anyway — but *asking* would be the tell that this path
 *   forgot which case the tool exists to serve.
 * - **Off the SQLite poll path.** Its own timer, its own cadence. A snapshot never awaits
 *   it: `enrich()` is a synchronous join against the last cached answer, so a CLI that hangs
 *   for a minute delays the SQLite snapshot by nothing.
 * - **Timeout-bounded.** Every spawn carries a kill timer. The CLI measured 0.3–0.9 s per
 *   call and up to ~2 s under load; past the bound it is an `unavailable`, not a wait.
 * - **Exact joins only.** `terminal list --json` is the minimum read-only metadata that can
 *   place a handle: it is the *only* place a handle ↔ worktree relationship exists (the ps
 *   `agents[]` carry pane keys, not handles). No join from prompt text, display names or
 *   timing — a worker the list cannot place gets nothing (#61 out of scope).
 * - **Never authoritative.** Failure of any kind — timeout, exit code, malformed JSON,
 *   schema drift — costs exactly the `enrichment` field, labelled honestly, and cannot
 *   delay, replace, clear or contradict the SQLite snapshot it rides on.
 * - **The cache serves snapshots, not failures.** "Caches the last success" means the hot
 *   path never spawns — every snapshot between refreshes is a join against the last good
 *   answer. It does not mean a *failed* refresh keeps serving that answer: `unavailable`
 *   clears it, because "here is what A2 is doing right now" sourced from before the CLI
 *   stopped answering is a guess wearing a timestamp, and this feature never guesses.
 *
 * **Read-only remains absolute** (SPEC §1.2). The two argv below are the whole command
 * surface: both are pure reads. Nothing here may ever go near a command that mutates
 * orchestration or mailbox state — `orca orchestration check` marks messages read, which is
 * exactly why the MVP ruled the CLI out as a data source (#4).
 */

/** The whole command surface of this tool, verbatim. Both are reads; neither has flags to add. */
export const WORKTREE_PS = ['worktree', 'ps', '--json'] as const;
export const TERMINAL_LIST = ['terminal', 'list', '--json'] as const;

/** The CLI as the user's shell knows it. */
const ORCA_BIN = 'orca';

/** Past this, a slow CLI is an `unavailable`, not a wait. ~3× the loaded per-call measurement. */
export const ENRICHMENT_TIMEOUT_MS = 3000;

/**
 * The adapter's own cadence — deliberately not the SQLite poll's 5 s. Two process spawns per
 * refresh are the most expensive thing this tool does; 10 s keeps "what is A2 doing" fresh
 * enough to supervise by while spending a fifth of what piggybacking on every tick would.
 */
export const ENRICHMENT_INTERVAL_MS = 10_000;

/**
 * Activity previews are capped like a `Turn` body is (SPEC §6.3): the snapshot is re-sent
 * whole every push, `toolInput` can be a 10 KB command line, and a rail row was never going
 * to show more than a glimpse. The terminal itself has the rest.
 */
export const ENRICHMENT_PREVIEW_CHARS = 240;

/**
 * The one seam between this module and a process table. Resolves to stdout; rejects on a
 * nonzero exit, a spawn failure, or the timeout. Injected so a test can script the CLI
 * without forking one — and so the suite can prove which argv are ever asked for.
 */
export type RunOrcaCommand = (args: readonly string[], timeoutMs: number) => Promise<string>;

export const runOrcaCommand: RunOrcaCommand = (args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      ORCA_BIN,
      args as string[],
      // The timeout SIGTERMs the child; maxBuffer guards against a ps output that grew
      // beyond reason becoming an unbounded buffer in a long-lived server.
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout))
    );
  });

/** One agent pane, as much of it as this build understands. Previews already capped. */
export type PsAgent = {
  state: string;
  agentType: string | null;
  lastAssistantMessage: string | null;
  toolName: string | null;
  toolInput: string | null;
  updatedAt: string | null;
};

/** One worktree out of `worktree ps`, reduced to exactly what the join reads. */
export type PsWorktree = {
  worktreeId: string;
  path: string;
  branch: string | null;
  repo: string | null;
  displayName: string | null;
  /**
   * How many live terminals the worktree really has — including ones `terminal list` cannot
   * name (verified live: a worktree reported 3 with zero list entries). Null when the field
   * is missing or not a number, and null can never satisfy the unambiguity check: drift
   * degrades to "no activity", never to a guess.
   */
  liveTerminalCount: number | null;
  /** Null when the field is missing or not an array — same rule: unparseable is never unambiguous. */
  agents: PsAgent[] | null;
};

/** One `terminal list` entry: the only place a handle ↔ worktree relationship exists. */
export type TerminalEntry = { handle: string; worktreeId: string };

/** The parsed pair one refresh produced — the cache the joins run against. */
export type OrcaView = { worktrees: PsWorktree[]; terminals: TerminalEntry[] };

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const preview = (value: unknown): string | null => asString(value)?.slice(0, ENRICHMENT_PREVIEW_CHARS) ?? null;

/**
 * Both commands answer the same envelope — `{ ok: true, result: { <container>: [...] } }` —
 * and both parsers apply the same rule: a malformed **container** is drift and fails the
 * whole read (the caller says `unavailable`); a malformed **entry** is skipped, because an
 * entry that cannot state its identity cannot join anything, and quietly narrowing the join
 * is the safe direction. This is that rule, written once.
 */
function parseEntries<T>(stdout: string, container: string, parse: (entry: Record<string, unknown>) => T | null): T[] {
  const envelope = JSON.parse(stdout) as { ok?: unknown; result?: Record<string, unknown> };
  const raw = envelope?.ok === true ? envelope.result?.[container] : undefined;
  if (!Array.isArray(raw)) throw new Error(`the orca CLI answered without a ${container} array`);

  const entries: T[] = [];
  for (const item of raw as unknown[]) {
    const parsed = parse(item as Record<string, unknown>);
    if (parsed !== null) entries.push(parsed);
  }
  return entries;
}

export function parseWorktreePs(stdout: string): PsWorktree[] {
  return parseEntries(stdout, 'worktrees', (entry) => {
    const worktreeId = asString(entry?.worktreeId);
    const path = asString(entry?.path);
    if (worktreeId === null || path === null) return null;

    return {
      worktreeId,
      path,
      branch: asString(entry.branch)?.replace(/^refs\/heads\//, '') ?? null,
      repo: asString(entry.repo),
      displayName: asString(entry.displayName),
      liveTerminalCount: typeof entry.liveTerminalCount === 'number' ? entry.liveTerminalCount : null,
      agents: Array.isArray(entry.agents) ? (entry.agents as unknown[]).map(parseAgent) : null,
    };
  });
}

function parseAgent(raw: unknown): PsAgent {
  const agent = raw as Record<string, unknown>;
  return {
    // Verbatim, like every enum this tool has never heard of (SPEC §5).
    state: asString(agent?.state) ?? '',
    agentType: asString(agent?.agentType),
    lastAssistantMessage: preview(agent?.lastAssistantMessage),
    toolName: asString(agent?.toolName),
    toolInput: preview(agent?.toolInput),
    updatedAt:
      typeof agent?.updatedAt === 'number' && Number.isFinite(agent.updatedAt)
        ? new Date(agent.updatedAt).toISOString()
        : null,
  };
}

export function parseTerminalList(stdout: string): TerminalEntry[] {
  return parseEntries(stdout, 'terminals', (entry) => {
    const handle = asString(entry?.handle);
    const worktreeId = asString(entry?.worktreeId);
    return handle === null || worktreeId === null ? null : { handle, worktreeId };
  });
}

/**
 * The join — and the whole honesty budget of the feature (#61).
 *
 * **Worktree context** needs an exact hit: this handle, in `terminal list`, naming a
 * worktree `ps` describes. One handle, one terminal entry, or nothing.
 *
 * **Activity** needs the join to be *unambiguous* on top of exact. The ps `agents[]` carry
 * pane keys, not handles, so "which agent is this terminal's" is only answerable when there
 * is nothing to choose between: exactly one agent in the worktree, exactly one listed
 * terminal, and a live-terminal count that agrees nothing unlisted is in there with it.
 * Anything less renders no activity — a worktree with three terminals and one agent is a
 * worktree where the agent may be somebody else's.
 */
export function joinWorkers(handles: Iterable<string>, view: OrcaView): EnrichedWorker[] {
  const workers: EnrichedWorker[] = [];

  for (const handle of new Set(handles)) {
    const entries = view.terminals.filter((terminal) => terminal.handle === handle);
    if (entries.length !== 1) continue; // absent, or (never seen live) duplicated — either way, no exact join

    const worktree = view.worktrees.find((candidate) => candidate.worktreeId === entries[0]!.worktreeId);
    if (worktree === undefined) continue;

    const worker: EnrichedWorker = {
      handle,
      worktree: {
        path: worktree.path,
        branch: worktree.branch,
        repo: worktree.repo,
        displayName: worktree.displayName,
      },
    };

    const activity = unambiguousActivity(worktree, view.terminals);
    if (activity !== null) worker.activity = activity;

    workers.push(worker);
  }

  return workers;
}

function unambiguousActivity(worktree: PsWorktree, terminals: TerminalEntry[]): EnrichedActivity | null {
  if (worktree.agents === null || worktree.agents.length !== 1) return null;
  if (worktree.liveTerminalCount !== 1) return null;
  if (terminals.filter((terminal) => terminal.worktreeId === worktree.worktreeId).length !== 1) return null;

  return worktree.agents[0]!;
}

export type EnrichmentOptions = {
  run?: RunOrcaCommand;
  timeoutMs?: number;
  intervalMs?: number;
};

/**
 * The separately-timed, cached path. `start()` owns a timer of its own; `refresh()` is one
 * spawn-and-parse; `enrich()` is the synchronous join every snapshot calls — cache in,
 * answer out, no I/O. `generation` is what lets the poll loop notice that live context
 * changed when the database did not (`stream.ts`).
 */
export class OrcaEnrichment {
  private readonly liveness: () => Liveness;
  private readonly run: RunOrcaCommand;
  private readonly timeoutMs: number;
  private readonly intervalMs: number;

  /** The last refresh's whole outcome — the three facts only ever move together. */
  private answer: Answer = { state: 'pending', view: null, fetchedAt: null };

  private counter = 0;
  /** What the last generation bump saw — `fetchedAt` deliberately excluded, or every good
   *  refresh of an unchanged Orca would push every browser a fresh timestamp and nothing else. */
  private fingerprint = '';

  private timer: NodeJS.Timeout | null = null;
  private refreshing = false;

  constructor(liveness: () => Liveness, options: EnrichmentOptions = {}) {
    this.liveness = liveness;
    this.run = options.run ?? runOrcaCommand;
    this.timeoutMs = options.timeoutMs ?? ENRICHMENT_TIMEOUT_MS;
    this.intervalMs = options.intervalMs ?? ENRICHMENT_INTERVAL_MS;
  }

  /** Moves only when the *answer* does. The poll loop treats a move exactly like a data_version change. */
  get generation(): number {
    return this.counter;
  }

  start(): void {
    if (this.timer !== null) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.intervalMs);
    // Like the poll loop's own timer: a refresh nobody will read must never hold the process up.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One ask. Public because the cadence is the ticket: a test drives refreshes by hand and
   * proves what each one did and did not spawn, without waiting a real interval out.
   */
  async refresh(): Promise<void> {
    if (this.refreshing) return; // a CLI slower than the interval queues nothing behind itself
    this.refreshing = true;

    try {
      // The live-only gate (#61): not live means **no command runs** — and the cache is
      // dropped, not kept warm. Terminal handles die with the app they belonged to, and
      // context cached before a shutdown would join yesterday's activity to a handle the
      // next Orca will never mint again.
      if (this.liveness() !== 'live') {
        this.settle({ state: 'suspended', view: null, fetchedAt: null });
        return;
      }

      const [ps, terminals] = await Promise.all([
        this.run(WORKTREE_PS, this.timeoutMs),
        this.run(TERMINAL_LIST, this.timeoutMs),
      ]);
      this.settle({
        state: 'ok',
        view: { worktrees: parseWorktreePs(ps), terminals: parseTerminalList(terminals) },
        fetchedAt: nowIso(),
      });
    } catch {
      // Timeout, nonzero exit, spawn failure, malformed JSON, drifted containers — one
      // honest word for all of them. The last good answer is *not* kept on screen: activity
      // this adapter can no longer vouch for is a guess wearing a timestamp.
      this.settle({ state: 'unavailable', view: null, fetchedAt: null });
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * The join the snapshot rides on — synchronous, cache-only, and therefore incapable of
   * delaying SQLite delivery by construction. `handles` is what the snapshot actually names
   * (orchestrators and cast); context for anybody else would be wire spent on nobody.
   */
  enrich(handles: Iterable<string>): Enrichment {
    const { state, view, fetchedAt } = this.answer;
    return {
      state,
      fetchedAt,
      workers: state === 'ok' && view !== null ? joinWorkers(handles, view) : [],
    };
  }

  private settle(answer: Answer): void {
    this.answer = answer;

    const fingerprint = answer.state + '\n' + (answer.view === null ? '' : JSON.stringify(answer.view));
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.counter += 1;
    }
  }
}

/** One refresh's outcome, whole — a state never travels without its view and its instant. */
type Answer = { state: EnrichmentState; view: OrcaView | null; fetchedAt: string | null };

/**
 * The enrichment-aware `StreamSource`: SQLite answers everything it always answered, and the
 * event leaves with the joined context attached. This wrapper — not `OrcaDatabase` — is what
 * the server hands the stream and the snapshot route while the opt-in is on, which is what
 * keeps the database class a pure SQLite reader.
 */
export function withEnrichment(source: StreamSource, adapter: OrcaEnrichment): StreamSource {
  return {
    dataVersion: () => source.dataVersion(),
    liveness: () => source.liveness(),
    enrichmentVersion: () => adapter.generation,
    push(since: number | null): PushResult {
      const result = source.push(since);

      // The handles come from the push itself (`PushResult.handles`) rather than off the event:
      // #69 took the full history off the wire, so the runs this joins against are no longer
      // *on* the thing being decorated. The source hands them over from the read it just did,
      // which keeps the exact join exact without a second pass over the database.

      // The liveness gate, enforced at the wire and not only on the timer. The SQLite poll
      // notices a quit within one tick; the adapter only on its own slower one — and for
      // that gap a cached `ok` would put "what the agent is doing right now" on screen
      // beside a stale badge, about an app that is not running. Live-only means the *event*
      // is never allowed to say both; the adapter's next tick then drops the cache for real.
      const enrichment: Enrichment =
        result.event.meta.liveness === 'live'
          ? adapter.enrich(result.handles)
          : { state: 'suspended', fetchedAt: null, workers: [] };

      return { ...result, event: { ...result.event, enrichment } };
    },
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

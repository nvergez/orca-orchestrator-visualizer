import type { DatabaseSync } from 'node:sqlite';
import type { CastMember, EvidenceHint, Run } from '../shared/types.ts';
import { type Columns, selectPresent, text } from './rows.ts';
import type { TaskWithHandle } from './runs.ts';

/**
 * **Evidence hints** (SPEC §12.4): the two labels this schema does not have, offered only when
 * the retained evidence could not be clearer — and refused otherwise.
 *
 * No column anywhere says what *kind* of agent a terminal was, or which *repository* an
 * orchestrator was working in. The evidence for both is lying around in retained strings, and
 * the live database shows exactly why a straightforward scan of them would lie:
 *
 * - A real spec reads *"You are a Claude Code agent … never launch Codex"*. Prose search finds
 *   two kinds in one sentence that declares exactly one.
 * - A real result reads `{"reason": "codex workspace out of credits"}` — written by a *Claude*
 *   worker, about somebody else's empty wallet.
 *
 * So the readers inspect **defined high-confidence positions only** — a `you are a <kind>`
 * declaration, a delimited branch segment, the `workspaces/<project>/<worktree>` layout Orca
 * itself creates — against a small, versioned allowlist. A hint exists only when **exactly one**
 * candidate survives everything read; two candidates is a refusal, not a choice. What ships is
 * explicitly uncertain (the client renders `claude?`) and carries its provenance, and it is a
 * label riding *beside* identity, never identity: run ids, monograms, task attribution and the
 * rail's grouping are decided before this module runs and are not touched by it.
 *
 * Everything here reads retained strings alone: no Orca CLI, and no check that a path still
 * exists — the same evidence has to keep hinting in archived replay, on a machine the worktree
 * never lived on.
 */

/**
 * Bump this when `AGENT_KINDS` changes. The allowlist is deliberately versioned data, not an
 * open pattern: a kind this build has never heard of yields no hint (never a guess), and which
 * kinds a build recognises should be an auditable fact about the build.
 */
export const AGENT_KIND_ALLOWLIST_VERSION = 1;

/** The coding agents this build can recognise — matched as whole tokens, never substrings. */
export const AGENT_KINDS: readonly string[] = ['aider', 'claude', 'codex', 'copilot', 'cursor', 'gemini'];

const KNOWN_KINDS: ReadonlySet<string> = new Set(AGENT_KINDS);

/**
 * The declaration position: `you are (a|an)? <token>`. A dispatch prompt that tells the worker
 * what it is — *"You are a Claude Code agent"* — is the one place a spec names the agent's own
 * kind rather than somebody it may or may not launch. The token is the word right after the
 * phrase; everything past it is prose again and is not read.
 */
const DECLARATION = /\byou\s+are\s+(?:an?\s+)?([a-z][a-z0-9]*)/gi;

/** The kinds a spec *declares* — never the kinds it merely mentions. Deduplicated, in text order. */
export function declaredKinds(spec: string): string[] {
  const kinds = new Set<string>();

  for (const match of spec.matchAll(DECLARATION)) {
    const token = match[1]!.toLowerCase();
    if (KNOWN_KINDS.has(token)) kinds.add(token);
  }

  return [...kinds];
}

/**
 * The kinds a branch name carries as whole delimited segments — `nvergez/94-codex` names codex,
 * `fix/claudette-rename` names nobody. A branch is a deliberate act of naming, which is what
 * makes a token in it high-confidence where the same token loose in prose is not.
 */
export function branchKinds(branch: string): string[] {
  const kinds = new Set<string>();

  for (const segment of branch.toLowerCase().split(/[^a-z0-9]+/)) {
    if (KNOWN_KINDS.has(segment)) kinds.add(segment);
  }

  return [...kinds];
}

/**
 * Absolute paths only. The lookbehind refuses a slash that continues something else — a URL's
 * `//`, a `github.com/...` path, a word — because those are exactly the strings where a
 * `workspaces` segment stops meaning Orca's layout.
 */
const POSIX_PATH = /(?<![:\w\\/.])\/[\w.@+~-]+(?:\/[\w.@+~-]+)+/g;
const WINDOWS_PATH = /\b[A-Za-z]:[\\/][\w.@+~-]+(?:[\\/][\w.@+~-]+)+/g;

/**
 * The project candidates a text names at the one high-confidence path position there is:
 * Orca's own worktree layout, `…/workspaces/<project>/<worktree>`. Everything else an absolute
 * path could mean — a scratchpad, a home directory, somebody's `~/projects` convention — is
 * refused, because a candidate this function returns is one refusal away from the screen.
 *
 * Strings in, strings out: no `stat`, no `realpath`, no existence check. An archived run's
 * paths exist on no machine and must hint exactly as well as a live one's.
 */
export function projectCandidates(source: string): string[] {
  const projects = new Set<string>();

  for (const pattern of [POSIX_PATH, WINDOWS_PATH]) {
    for (const match of source.matchAll(pattern)) {
      const segments = match[0].split(/[\\/]+/).filter((segment) => segment !== '');
      const layout = segments.indexOf('workspaces');
      const project = layout === -1 ? undefined : segments[layout + 1];

      // The full layout or nothing: a path that stops at the project could be anything, and a
      // dot segment at the project position is bookkeeping (`.trash`), not a repository.
      if (project !== undefined && segments.length > layout + 2 && !project.startsWith('.')) {
        projects.add(project);
      }
    }
  }

  return [...projects];
}

/**
 * One task's retained evidence, with the two joins the readers cannot make for themselves:
 * which run the task landed in, and whose report its result is.
 */
export type TaskHintEvidence = {
  taskId: string;
  runId: string;
  /**
   * The latest attempt's assignee — the agent whose report `result` is. Result-derived kind
   * evidence goes to this handle *only*: an earlier attempt's agent never wrote it, and reading
   * it as evidence of that agent's kind would be a guess about the wrong terminal.
   */
  latestAssignee: string | null;
  /** The full bodies — not the wire's 240-char previews, which end before most declarations do. */
  spec: string | null;
  result: string | null;
};

/**
 * Read the evidence: the full `spec` and `result` of every task, joined to the run and the
 * latest assignee the entries already know.
 *
 * This is the one reader that takes the bodies whole. `tasks.ts` slices them to 240 characters
 * in SQL so they never cross the SQLite boundary (SPEC §6.3) — but a declaration sits mid-prompt
 * and a worktree path sits wherever the orchestrator typed it, so scanning previews would just
 * be scanning the wrong strings. The budget §6.3 protects is the **wire**, and that is intact:
 * the bodies are read once per changed tick, reduced to a few bytes of hint, and dropped.
 */
export function readHintEvidence(db: DatabaseSync, columns: Columns, entries: TaskWithHandle[]): TaskHintEvidence[] {
  const bodies = new Map<string, { spec: string | null; result: string | null }>();

  for (const row of selectPresent(db, 'tasks', columns.tasks, ['id', 'spec', 'result'])) {
    const id = text(row.id);
    if (id !== null) bodies.set(id, { spec: text(row.spec), result: text(row.result) });
  }

  return entries.map((entry) => ({
    taskId: entry.task.id,
    runId: entry.task.runId,
    latestAssignee: entry.attempts.at(-1)?.assigneeHandle || null,
    spec: bodies.get(entry.task.id)?.spec ?? null,
    result: bodies.get(entry.task.id)?.result ?? null,
  }));
}

/** The slice of a message the branch evidence needs — `FeedMessage` satisfies it. */
export type WorkerReport = { type: string; fromHandle: string; payload: unknown };

/**
 * Hang the hints on the runs and their casts — and change nothing else.
 *
 * The refusal rule lives here: each candidate map is kept per kind/project with the sources
 * that supported it, and a hint is emitted only when the map holds **exactly one** entry.
 * Absent stays absent on the wire (no `null`s — the `Turn` rule; the snapshot is re-sent whole
 * every five seconds).
 */
export function attachHints(runs: Run[], evidence: TaskHintEvidence[], messages: readonly WorkerReport[]): Run[] {
  const byTask = new Map(evidence.map((held) => [held.taskId, held]));
  const byRun = new Map<string, TaskHintEvidence[]>();
  for (const held of evidence) {
    const bucket = byRun.get(held.runId);
    if (bucket) bucket.push(held);
    else byRun.set(held.runId, [held]);
  }

  // Every branch a worker reported on completion, by the terminal that said so. `worker_done`
  // is the one message type whose payload has a defined `branch` field in the wild; the sender
  // is who the branch names, so the evidence never spreads past its own author.
  const branchesByHandle = new Map<string, string[]>();
  for (const message of messages) {
    if (message.type !== 'worker_done' || message.fromHandle === '') continue;
    const branch = branchField(message.payload);
    if (branch === null) continue;

    const held = branchesByHandle.get(message.fromHandle);
    if (held) held.push(branch);
    else branchesByHandle.set(message.fromHandle, [branch]);
  }

  return runs.map((run) => {
    const repoHint = repoHintOf(byRun.get(run.id) ?? []);

    return {
      ...run,
      cast: run.cast.map((member) => {
        const kindHint = kindHintOf(member, byTask, branchesByHandle);
        return kindHint === null ? member : { ...member, kindHint };
      }),
      ...(repoHint === null ? {} : { repoHint }),
    };
  });
}

/**
 * One cast member's kind, from everything retained about it: the declaration in each spec it was
 * dispatched (every attempt received the prompt), the branch in the result it completed (the
 * latest assignee's report, nobody else's), and the branches its own `worker_done`s carried.
 */
function kindHintOf(
  member: CastMember,
  byTask: ReadonlyMap<string, TaskHintEvidence>,
  branchesByHandle: ReadonlyMap<string, string[]>
): EvidenceHint | null {
  const supported = new Candidates();

  for (const taskId of member.taskIds) {
    const held = byTask.get(taskId);
    if (held === undefined) continue;

    if (held.spec !== null) {
      for (const kind of declaredKinds(held.spec)) supported.add(kind, 'spec');
    }
    if (held.result !== null && held.latestAssignee === member.handle) {
      const branch = branchField(parseJson(held.result));
      if (branch !== null) for (const kind of branchKinds(branch)) supported.add(kind, 'branch');
    }
  }

  for (const branch of branchesByHandle.get(member.handle) ?? []) {
    for (const kind of branchKinds(branch)) supported.add(kind, 'branch');
  }

  return supported.solitary();
}

/**
 * One run's project, from the absolute-path evidence retained across its tasks. Agreement is
 * judged inside the run: the machine-global file mixes every repository, and another
 * orchestrator's project is not this one's conflict.
 */
function repoHintOf(evidence: readonly TaskHintEvidence[]): EvidenceHint | null {
  const candidates = new Candidates();

  for (const held of evidence) {
    if (held.spec !== null) {
      for (const project of projectCandidates(held.spec)) candidates.add(project, 'task specs');
    }
    if (held.result !== null) {
      for (const project of projectCandidates(held.result)) candidates.add(project, 'task results');
    }
  }

  return candidates.solitary();
}

/** Candidates with their provenance — and the refusal: a hint is one survivor or nothing. */
class Candidates {
  private readonly sourcesOf = new Map<string, Set<string>>();

  add(value: string, source: string): void {
    const sources = this.sourcesOf.get(value);
    if (sources) sources.add(source);
    else this.sourcesOf.set(value, new Set([source]));
  }

  /**
   * The hint, iff exactly one candidate survived. Two candidates is conflicting evidence and
   * zero is none — both are the same honest answer, which is no answer at all (SPEC §12.4).
   */
  solitary(): EvidenceHint | null {
    if (this.sourcesOf.size !== 1) return null;

    const [value, sources] = [...this.sourcesOf][0]!;
    return { value, sources: [...sources] };
  }
}

/** `tasks.result` is JSON on every live row, and nothing enforces that it stays so. */
function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The `branch` field of a completion payload — a *defined* field, which is what separates it
 * from the `reason` prose sitting next to it in real rows. Anything but a non-empty string is
 * no evidence.
 */
function branchField(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;

  const branch = (payload as Record<string, unknown>).branch;
  return typeof branch === 'string' && branch !== '' ? branch : null;
}

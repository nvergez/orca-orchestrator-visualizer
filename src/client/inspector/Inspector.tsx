import { OctagonAlert, X } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo } from 'react';
import { Spotlight, useSpotlight } from '@/components/fx/spotlight';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { CastMember, Completion, Dispatch, Gate, Task, TaskDetail, Turn } from '../../shared/types.ts';
import { GATE_THEME, type StatusTheme, themeOf } from '../canvas/theme.ts';
import { CHIP_CLASS } from '../chip.ts';
import { selectTurns } from '../conversation/select.ts';
import { TurnRow } from '../conversation/TurnRow.tsx';
import { COPY_ON_HOVER, CopyButton, CopyId } from '../copy.tsx';
import { ReceiptFacts } from '../receipt.tsx';
import { BAND_IN, DOCK_IN, enter, SECTION_IN, SPRING } from '../motion.ts';
import { ageOf, useNow } from '../relative-time.ts';
import { DOCK_CLASS, PANEL_HEADER_CLASS, PANEL_TITLE_CLASS } from '../surface.ts';
import { useIsMobile } from '../viewport.tsx';

/**
 * The whole story of one task (SPEC §7.8) — the panel that swaps in over the conversation when a
 * node is selected, and swaps back out when it is let go.
 *
 * It is the answer to the question a graph cannot answer: *what actually happened here.* Top to
 * bottom, and each piece is there because a post-mortem goes looking for it:
 *
 * 1. **The header** — the title, the status, and the **task id in full**, copyable, because the
 *    next thing you do with a task you are looking at is paste it into an `orca orchestration`
 *    command. The node shows a short id; a command line needs the whole one.
 * 2. **The spec** the agent was dispatched with, and **the result** that came back — in **full**.
 *    Fetched on the click and never carried in a snapshot: 172 KB of prompt text on a live database
 *    (SPEC §6.3). The conversation below shows the first 240 characters of each; this is where the
 *    rest of them are.
 * 3. **Every dispatch attempt**, in `rowid` order, **as a timeline** (SPEC §7.9).
 *    `dispatch_contexts` is the only genuinely append-only per-task history in this schema, and a
 *    retry is a *sequence* — so it is drawn as one, down a rail, rather than as three cards that
 *    happen to be stacked. The node has room for the latest attempt and a count; *this* is where the
 *    retry and circuit-breaker story is actually legible.
 * 4. **The exchange** — this task's slice of the conversation, oldest first (SPEC §4.7). It replaces
 *    the flat list of messages that used to sit here, and the upgrade is the whole feature: a list of
 *    messages is *the half of the exchange that got written down*. The prompt the agent was
 *    dispatched with, the orchestrator's answer to a gate, and the final receipt are not messages at
 *    all — Orca injects a dispatch straight into the worker's PTY (SPEC §4.2, trap 2) — so they could
 *    never have appeared in it. Now both sides do.
 * 5. **The gate Q&A, answered ones included.** The node's ⛔ marker only ever shows an *open* gate;
 *    an answered question is how you reconstruct the decision that sent the run the way it went.
 * 6. **Dependencies, in and out**, as chips that select the neighbour — the DAG, walked one hop at a
 *    time, without hunting for the node on the canvas.
 *
 * Everything except the two bodies and the attempts comes from the **snapshot** and renders
 * immediately — the header, the exchange, the gates and the chips are on the wire already — so the
 * panel is useful before the fetch lands and stays useful if the fetch fails.
 *
 * The sections **stagger in, top to bottom** — the order a post-mortem reads them, at 40 ms a step
 * and capped at a quarter of a second. It is not decoration: it is the panel telling you where its
 * top is, on a dock that has just replaced something else.
 */

export type InspectorProps = {
  task: Task;
  /** **Every** gate this task raised — open and answered alike (`snapshot.gates`, #19). */
  gates: Gate[];
  /**
   * **Every task in the database**, not the canvas's — a dep is an id, and a person needs a title.
   *
   * Not the selected run's, and the difference is a bug this panel would otherwise ship: a run is
   * *inferred* (`runs.ts` buckets by handle and splits on a six-hour gap), while `tasks.deps` is a
   * real edge in the schema that knows nothing about that inference. A dependency crossing into
   * the next inferred run — or into the synthetic `Unattributed` one, where 4 of 76 live tasks
   * sit — is still perfectly present in the file, and calling it deleted would be a lie.
   */
  tasks: Task[];
  /** The bodies and the attempts. Null until the fetch lands (`detail.ts`). */
  detail: TaskDetail | null;
  /** Why it did not land. The rest of the panel renders anyway. */
  error: string | null;
  /**
   * **This task's whole exchange, both sides of it** — the task-scoped slice of `snapshot.turns`
   * (SPEC §4.7).
   *
   * It replaces the flat list of messages this panel used to fetch, and the difference is the whole
   * point of the feature: the messages whose `payload.taskId` was this task are only *the half of
   * the exchange that got written down*. The prompt the agent was dispatched with, the
   * orchestrator's answer to a gate and the final receipt are not messages at all — Orca injects a
   * dispatch straight into the worker's PTY (SPEC §4.2, trap 2) — so they could never have appeared
   * in it. Here, they do.
   */
  turns: Turn[];
  /** The orchestrator's agents — what turns a handle into an `A2` and a colour. */
  cast: CastMember[];
  /** Let the task go: the dock returns to the conversation. */
  onClose: () => void;
  /** Walk to a neighbour — it *selects*, it does not toggle. */
  onSelectTask: (taskId: string) => void;
  /**
   * The run the reader was standing in when a gate, dep chip or turn followed a task across
   * into this one (`App.showTask`) — mobile-only narration, because on the folded shell the
   * rail's moving `aria-current` is behind a collapsed band and a silent run-hop reads as the
   * canvas replacing itself for no reason. Null (the default, and always on desktop) renders
   * nothing.
   */
  hoppedFrom?: string | null;
};

export function Inspector({
  task,
  gates,
  tasks,
  detail,
  error,
  turns,
  cast,
  onClose,
  onSelectTask,
  hoppedFrom = null,
}: InspectorProps) {
  const isMobile = useIsMobile();

  // What this task waited for, and what waited on it. The forward edges are the task's own
  // `deps`; the back edges are every task in the *database* that names it — a dependent in
  // another inferred run is still a dependent, and dropping it would hide a real edge.
  const dependents = useMemo(
    () => tasks.filter((candidate) => candidate.deps.includes(task.id)).map((candidate) => candidate.id),
    [tasks, task.id]
  );

  // This task's exchange, end to end. The scoping is a filter over turns the server already merged
  // (`conversation/select.ts`) — no second derivation, and the heartbeats are already collapsed to
  // one line, which is what the "show heartbeats" toggle used to have to do here by hand.
  const exchange = useMemo(() => selectTurns(turns, { runId: null, taskId: task.id }), [turns, task.id]);

  // One clock, so every age in this panel is measured from the same instant (`relative-time.ts`).
  const now = useNow(detail);

  // The stagger counts sections as they are *rendered*, not as they are declared: the error branch
  // replaces four of them with one, and a hard-coded index would leave a hole in the sequence.
  let step = 0;
  const next = (): number => step++;

  return (
    <motion.aside
      data-testid="inspector"
      aria-label={`Task ${task.title}`}
      variants={isMobile ? BAND_IN : DOCK_IN}
      initial={enter('hidden')}
      animate="shown"
      transition={SPRING}
      className={DOCK_CLASS}
    >
      <Header task={task} hoppedFrom={hoppedFrom} onClose={onClose} />

      {/* The same dock the conversation wears (`surface.ts`) — it *is* the same dock — and the one
          thing that is this panel's own: it scrolls as a whole, because a spec, an attempt history
          and an exchange do not divide a fixed height between them in any honest way. */}
      <ScrollArea className="min-h-0 flex-1">
        {/*
          Everything the *route* was going to say, and one honest line instead when it could not
          say it. "No spec was dispatched" would be a lie here: what happened is that nobody knows
          — and the sections below, which are the snapshot's, are unaffected and stay.
        */}
        {error !== null ? (
          <Section title="Spec, result and attempts" index={next()}>
            <p className="text-destructive mt-1 text-[11px]">{error}</p>
          </Section>
        ) : (
          <>
            <Section title="Spec" index={next()}>
              <Body text={detail?.spec ?? null} loading={detail === null} empty="No spec was dispatched with this task." />
            </Section>

            <Section title="Result" index={next()}>
              <Body
                text={detail?.result ?? null}
                loading={detail === null}
                empty="No result yet — nothing has been reported back."
              />
            </Section>

            {/*
              **The outcome receipts** (#67, SPEC §12.4) — what the two evidence columns
              verifiably said this task produced, and the raw evidence itself. The facts are the
              server's one reading, merged across `tasks.result` and every `worker_done` payload
              that named the task, with each fact's provenance *on screen* — which is what makes
              a deduplicated fact honest and keeps a conflict two visible facts. Uncapped: the
              conversation's compact summary points here for the rest.

              It claims no space when there is nothing to claim it with: a prose result and no
              completion is the ordinary case, not a lesser one.
            */}
            {detail !== null && (detail.receipt.length > 0 || detail.completions.length > 0) && (
              <Section title="Outcome receipts" index={next()}>
                <div data-testid="outcome-receipts">
                  <ReceiptFacts facts={detail.receipt} showSources />
                  {detail.completions.length > 0 && (
                    <ul className="mt-2 flex flex-col gap-2">
                      {detail.completions.map((completion) => (
                        <li key={completion.messageId}>
                          <CompletionEvidence completion={completion} now={now} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Section>
            )}

            <Section title={attemptsTitle(detail?.attempts?.length ?? task.attemptCount)} index={next()}>
              <Attempts attempts={detail?.attempts ?? null} loading={detail === null} now={now} />
            </Section>

          </>
        )}

        {/*
          **The exchange** — and it is a section of the inspector rather than a panel of its own,
          because a node click has always opened *this task's story* and the exchange is the half of
          that story the tool could not previously tell. Oldest first: it is a story, and a story
          starts at the beginning.

          It renders outside the `error` branch above, and deliberately: the turns are the
          *snapshot's* (SPEC §4.7), not the fetch's, so a `GET /api/task/:id` that failed costs the
          two bodies and the attempt history — and the conversation goes on being readable.
        */}
        <Section title="Exchange" index={next()}>
          {exchange.length === 0 ? (
            <p data-testid="exchange-empty" className="text-muted-foreground mt-2 text-[11px] text-balance">
              Nothing was ever said about this task — no agent was ever given it, and none reported
              back.
            </p>
          ) : (
            <ol data-testid="exchange" className="mt-2.5 flex flex-col gap-3">
              {exchange.map((turn) => (
                <li key={turn.id} className="flex flex-col">
                  {/* No `onSelectTask`: every turn here already names the task you are standing on. */}
                  <TurnRow turn={turn} cast={cast} now={now} />
                </li>
              ))}
            </ol>
          )}
        </Section>

        {gates.length > 0 && (
          <Section title={gates.length === 1 ? 'Decision gate' : `Decision gates (${gates.length})`} index={next()}>
            <ul className="mt-2 flex flex-col gap-2">
              {gates.map((gate) => (
                <li key={gate.id}>
                  <GateQA gate={gate} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Depends on" index={next()}>
          <Deps
            testId="deps-in"
            ids={task.deps}
            tasks={tasks}
            onSelectTask={onSelectTask}
            empty="Nothing — this task waited for nobody."
          />
        </Section>

        <Section title="Blocks" index={next()}>
          <Deps
            testId="deps-out"
            ids={dependents}
            tasks={tasks}
            onSelectTask={onSelectTask}
            empty="Nothing — no task in this run waited for it."
          />
        </Section>
      </ScrollArea>
    </motion.aside>
  );
}

/**
 * The title, the status, and the id.
 *
 * The id is the one thing here that is not decoration: `orca orchestration` takes a task id, and
 * a person reading the canvas has nowhere else to get the whole one. So it is shown in full and
 * copied on a click — and it is still selectable text when the clipboard API is not there at all
 * (an `http://` origin that is not localhost has none).
 */
function Header({ task, hoppedFrom, onClose }: { task: Task; hoppedFrom: string | null; onClose: () => void }) {
  const theme = themeOf(task.status);

  return (
    <header className={cn(PANEL_HEADER_CLASS, 'relative gap-2 overflow-hidden')}>
      {/* The task's own status, as a wash behind its name — so the panel is *this* task's before
          a word of it is read, the way the node it came from was. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.07]"
        style={{ background: `radial-gradient(120% 100% at 0% 0%, ${theme.accent}, transparent 70%)` }}
      />

      <div className="relative flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm leading-snug font-semibold">{task.title}</h2>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="Close the inspector and go back to the conversation"
          aria-label="Close the inspector"
          className="text-muted-foreground hover:text-foreground -mt-1 -mr-1 size-7 shrink-0 cursor-pointer max-lg:size-10"
        >
          <X className="size-4" />
        </Button>
      </div>

      {hoppedFrom && (
        <p data-testid="cross-run-note" className="text-muted-foreground relative truncate font-mono text-[10px]">
          followed here from {hoppedFrom}
        </p>
      )}

      <div className="relative flex flex-wrap items-center gap-1.5">
        <StatusChip status={task.status} theme={theme} />
        {task.attemptCount > 1 && (
          <span data-testid="retry-marker" className="text-[11px] font-bold text-amber-700 dark:text-amber-400">
            ↻{task.attemptCount} attempts
          </span>
        )}
        <CopyId id={task.id} label="task id" />
      </div>
    </header>
  );
}

/** The raw status string, in its colour — an unknown one is neutral grey and still shown (SPEC §5). */
function StatusChip({ status, theme }: { status: string; theme: StatusTheme }) {
  return (
    <Badge
      data-testid="status-chip"
      variant="outline"
      className={cn('rounded px-1.5 py-0 text-[11px] font-semibold', theme.surface)}
    >
      {status}
    </Badge>
  );
}

/**
 * A body — the spec, or the result. Two states before there is one to show, and they are
 * different facts: it is on its way, or the task genuinely has none.
 */
function Body({ text, loading, empty }: { text: string | null; loading: boolean; empty: string }) {
  if (loading) return <p className="text-muted-foreground mt-1 text-[11px]">Reading…</p>;
  if (text === null) return <p className="text-muted-foreground mt-1 text-[11px]">{empty}</p>;

  return (
    <pre
      className={cn(
        'bg-muted/60 text-foreground/90 border-panel-border/60 mt-2 rounded-lg border p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap',
        // The agent wrote prose and it is read as prose — but a spec that is 4 KB of it must not
        // push the sections below it off the panel. Below `lg` the clamp comes off: a scroller
        // inside the panel's one outer ScrollArea is a touch-scroll trap, and on the folded shell
        // that outer scroll is the only honest way through a long body.
        'max-h-56 overflow-y-auto max-lg:max-h-none'
      )}
    >
      {text}
    </pre>
  );
}

/**
 * One `worker_done` payload, raw and whole (#67) — the evidence under the facts above it.
 *
 * Verbatim is the contract: an unknown shape, an unrecognized field, a value the readers had
 * never seen — all of it reaches the screen exactly as the worker wrote it, because whatever
 * was not recognized is still retained evidence, and evidence that disappears when the parser
 * shrugs is the failure this whole feature exists to prevent. A payload that never parsed at
 * all renders as the string it is.
 *
 * The message id is real and Orca-written — `orca orchestration` can name it — so it copies,
 * the way every real id in this panel does (SPEC §7.9).
 */
function CompletionEvidence({ completion, now }: { completion: Completion; now: number }) {
  return (
    <section
      data-testid="completion"
      className="group/copy bg-muted/40 border-panel-border/60 rounded-lg border p-2.5"
    >
      <header className="text-muted-foreground flex items-center gap-1 font-mono text-[10px]">
        <span>worker_done · payload</span>
        <CopyButton
          value={completion.messageId}
          label="message id"
          className={cn('size-5 pointer-coarse:size-8', COPY_ON_HOVER)}
        />
        {completion.at !== '' && (
          <span className="ml-auto tabular-nums" title={ageOf(completion.at, now).title}>
            {ageOf(completion.at, now).label}
          </span>
        )}
      </header>

      <pre
        data-testid="completion-payload"
        className="text-foreground/90 mt-1.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap"
      >
        {typeof completion.payload === 'string' ? completion.payload : JSON.stringify(completion.payload, null, 2)}
      </pre>
    </section>
  );
}

/** The count is the headline: `> 1` is the whole retry story, said before the rows are read. */
function attemptsTitle(count: number): string {
  return count > 1 ? `Dispatch attempts (${count})` : 'Dispatch';
}

/**
 * **Every** attempt, oldest first — the ticket's whole reason for existing, drawn as the timeline
 * it actually is (SPEC §7.9).
 *
 * The node badge shows the latest attempt because it has room for one. The rows it folded away
 * are the only record that this task was ever retried: who else held it, how many times it
 * failed, and whether the third attempt tripped the circuit breaker (Orca trips it at 3). Three
 * stacked cards say "three things"; a rail with three stops on it says "this happened, then this,
 * then this" — which is the fact.
 */
function Attempts({ attempts, loading, now }: { attempts: Dispatch[] | null; loading: boolean; now: number }) {
  if (loading) return <p className="text-muted-foreground mt-1 text-[11px]">Reading…</p>;
  if (attempts === null || attempts.length === 0) {
    return <p className="text-muted-foreground mt-1 text-[11px]">Never dispatched — no agent has held this task.</p>;
  }

  return (
    <ol className="relative mt-2 flex flex-col gap-2">
      {attempts.map((dispatch, index) => (
        <Attempt
          key={dispatch.id || index}
          dispatch={dispatch}
          index={index}
          total={attempts.length}
          last={index === attempts.length - 1}
          now={now}
        />
      ))}
    </ol>
  );
}

function Attempt({
  dispatch,
  index,
  total,
  last,
  now,
}: {
  dispatch: Dispatch;
  index: number;
  total: number;
  last: boolean;
  now: number;
}) {
  const theme = dispatchTheme(dispatch.status);
  const spotlight = useSpotlight();

  return (
    <li data-testid="attempt" className="relative pl-5">
      {/* The rail, and this attempt's stop on it. The line does not run past the last one: a
          timeline that continues after the end is a timeline promising something that never came. */}
      <span aria-hidden className={cn('absolute top-1.5 left-[3px] size-2 rounded-full', theme.dot)} />
      {!last && <span aria-hidden className="bg-border absolute top-4 bottom-[-0.5rem] left-[6px] w-px" />}

      <div
        className={cn(
          'group group/copy bg-muted/40 border-panel-border/60 relative rounded-lg border p-2.5',
          'overflow-hidden'
        )}
        {...spotlight}
      >
        <Spotlight colour={theme.accent} />

        <div className="relative flex flex-wrap items-center gap-1.5">
          <b className="text-[11px] font-semibold">
            Attempt {index + 1} of {total}
          </b>

          <StatusChip status={dispatch.status} theme={theme} />

          {dispatch.failureCount > 0 && (
            <span data-testid="failure-count" className="text-[11px] font-bold text-red-700 dark:text-red-400">
              ✗{dispatch.failureCount}
            </span>
          )}

          {/* Who held this attempt — and, on hover, the whole of their handle rather than the eight
              hex the badge has room for. It is the identity you would `orchestration send` to, and
              a retry is exactly the moment you want to go and ask them what happened. */}
          {dispatch.assigneeHandle !== '' && (
            <span className="ml-auto flex items-center gap-0.5">
              <span
                data-testid="assignee"
                title={dispatch.assigneeHandle}
                className="bg-foreground/85 text-background rounded px-1.5 py-px font-mono text-[10px]"
              >
                {shortHandle(dispatch.assigneeHandle)}
              </span>
              <CopyButton
                value={dispatch.assigneeHandle}
                label="agent handle"
                className={cn('size-5 pointer-coarse:size-8', COPY_ON_HOVER)}
              />
            </span>
          )}
        </div>

        <dl className="text-muted-foreground relative mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          <Fact label="Dispatched" at={dispatch.dispatchedAt} now={now} />
          <Fact label="Completed" at={dispatch.completedAt} now={now} />
          <Fact label="Last failure" at={dispatch.lastFailure} now={now} />
          <Fact label="Last seen" at={dispatch.lastHeartbeatAt} now={now} />
        </dl>
      </div>
    </li>
  );
}

/** One instant, or nothing at all: a row for a timestamp the attempt never had would say nothing. */
function Fact({ label, at, now }: { label: string; at: string | null; now: number }) {
  if (at === null || at === '') return null;

  // The same reader a turn's age goes through (`relative-time.ts`) — including what it does with a
  // string that is not a timestamp at all, which is show it as it was written.
  const age = ageOf(at, now);

  return (
    <>
      <dt className="opacity-70">{label}</dt>
      <dd className="text-foreground/80 m-0 tabular-nums" title={age.title}>
        {age.label}
      </dd>
    </>
  );
}

/**
 * A dispatch status wears the colour of the task status of the same name, so the panel and the
 * canvas agree: a failed attempt is red, a live one amber, a finished one green — and a status
 * from an Orca this build has never heard of is neutral grey, exactly as a node's would be
 * (`themeOf`, SPEC §5).
 *
 * `circuit_broken` is the one word the two enums do not share, and it is the loudest thing a
 * dispatch row can say: three failures and Orca stopped trying. Red, like the failures it is
 * made of.
 */
function dispatchTheme(status: string): StatusTheme {
  return themeOf(status === 'circuit_broken' ? 'failed' : status);
}

/**
 * A question this task raised, and what was decided — **including a gate that was already
 * answered**, which is the point of showing it here at all. The node marks only an *open* gate;
 * the answer to a closed one is what tells you why the run went the way it did.
 *
 * It never offers to answer: this tool does not write to the database (SPEC §1.2).
 */
function GateQA({ gate }: { gate: Gate }) {
  const open = gate.status === 'open';

  return (
    <section
      data-testid="gate-qa"
      className={cn(
        'group/copy relative overflow-hidden rounded-lg border p-2.5 text-xs',
        // An open question is the colour of a blocker; an answered one is history, and history
        // is quiet.
        open ? GATE_THEME.surface : 'bg-muted/40 text-foreground/80 border-panel-border/60'
      )}
      style={
        open
          ? { boxShadow: '0 0 20px -10px color-mix(in oklch, var(--gate) 80%, transparent)' }
          : undefined
      }
    >
      <div className="relative flex items-start gap-1.5">
        <p className="flex min-w-0 flex-1 gap-1.5 font-semibold whitespace-pre-line">
          {open && <OctagonAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
          <span>{gate.question}</span>
        </p>

        {/* The id of the message — or, for a table-only gate, the row — this question came from
            (SPEC §4.5). It is never printed anywhere in the tool, and it is what a person answering
            the gate somewhere else has to name. */}
        <CopyButton value={gate.id} label="gate id" className={cn('-mt-0.5 -mr-0.5 size-5 pointer-coarse:size-8', COPY_ON_HOVER)} />
      </div>

      {gate.options.length > 0 && (
        <div className="relative mt-1.5 flex flex-wrap gap-1">
          {gate.options.map((option) => (
            <span
              key={option}
              className={cn(
                'rounded-full border px-2 py-px text-[11px] font-medium max-lg:py-1',
                open ? 'border-gate/60 bg-background/70' : 'bg-background'
              )}
            >
              {option}
            </span>
          ))}
        </div>
      )}

      <p className="relative mt-1.5 text-[11px]">
        {open ? (
          <i>Waiting — nobody has answered this yet.</i>
        ) : (
          <>
            <b>Answered:</b> <span className="whitespace-pre-line">{gate.resolution ?? '(no answer was recorded)'}</span>
          </>
        )}
      </p>
    </section>
  );
}

/**
 * The DAG, one hop at a time. A chip is a **button** when the neighbour is a task on this canvas,
 * and plain text when it is not: `deps` can name a task an `orchestration reset` deleted, and
 * there are no foreign keys in this schema to stop it (SPEC §4.2, trap 8). The canvas drops that
 * edge; the chip admits it rather than offering a click that goes nowhere.
 */
function Deps({
  testId,
  ids,
  tasks,
  onSelectTask,
  empty,
}: {
  testId: string;
  ids: string[];
  tasks: Task[];
  onSelectTask: (taskId: string) => void;
  empty: string;
}) {
  if (ids.length === 0) {
    return (
      <p data-testid={testId} className="text-muted-foreground mt-1 text-[11px]">
        {empty}
      </p>
    );
  }

  return (
    <div data-testid={testId} className="mt-2 flex flex-wrap gap-1.5">
      {ids.map((id) => {
        const neighbour = tasks.find((candidate) => candidate.id === id);

        return neighbour === undefined ? (
          <span
            key={id}
            title="This task is not in the database any more — a reset deleted it."
            className="border-border bg-muted/50 text-muted-foreground inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
          >
            <span className="truncate">{id}</span> · gone
          </span>
        ) : (
          <button
            key={id}
            type="button"
            onClick={() => onSelectTask(id)}
            title={`${neighbour.status} — show this task`}
            className={cn(CHIP_CLASS, 'max-w-full cursor-pointer max-lg:py-1.5')}
          >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', themeOf(neighbour.status).dot)} />
            <span className="truncate">{neighbour.title}</span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * One section, and its place in the order the panel arrives in. The `index` is the stagger's, and
 * it is handed in rather than counted here: a section does not know what came before it.
 */
function Section({ title, index, children }: { title: string; index: number; children: React.ReactNode }) {
  return (
    <motion.section
      custom={index}
      variants={SECTION_IN}
      initial={enter('hidden')}
      animate="shown"
      className="border-panel-border/60 border-b px-4 py-3 last:border-b-0"
    >
      <h3 className={cn(PANEL_TITLE_CLASS, 'text-[10px]')}>{title}</h3>
      {children}
    </motion.section>
  );
}

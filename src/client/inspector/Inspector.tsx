import { Check, Copy, OctagonAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { shortHandle } from '../../shared/handles.ts';
import type { Dispatch, Gate, Task, TaskDetail } from '../../shared/types.ts';
import { GATE_THEME, type StatusTheme, themeOf } from '../canvas/theme.ts';
import { CHIP_CLASS } from '../chip.ts';
import { DOCK_CLASS } from '../dock.ts';
import { HeartbeatToggle } from '../feed/HeartbeatToggle.tsx';
import { MessageRow } from '../feed/MessageRow.tsx';
import { viewOf } from '../feed/select.ts';
import { ageOf } from '../relative-time.ts';

/**
 * The whole story of one task (SPEC §7.8) — the panel that swaps in over the feed when a node is
 * selected, and swaps back out when it is let go.
 *
 * It is the answer to the question a graph cannot answer: *what actually happened here.* Top to
 * bottom, and each piece is there because a post-mortem goes looking for it:
 *
 * 1. **The header** — the title, the status, and the **task id in full**, copyable, because the
 *    next thing you do with a task you are looking at is paste it into an `orca orchestration`
 *    command. The node shows a short id; a command line needs the whole one.
 * 2. **The spec** the agent was dispatched with, and **the result** that came back. Fetched on
 *    the click and never carried in a snapshot — 172 KB of prompt text on a live database (SPEC
 *    §6.3).
 * 3. **Every dispatch attempt**, in `rowid` order. `dispatch_contexts` is the only genuinely
 *    append-only per-task history in this schema: the node has room for the latest attempt and a
 *    retry count, and *this* is where the retry and circuit-breaker story is actually legible.
 * 4. **The messages that named this task**, oldest first — a story, unlike the feed, which
 *    answers "what just happened" and so reads backwards.
 * 5. **The gate Q&A, answered ones included.** The node's ⛔ marker only ever shows an *open*
 *    gate; an answered question is how you reconstruct the decision that sent the run the way it
 *    went, and it lives nowhere else on screen.
 * 6. **Dependencies, in and out**, as chips that select the neighbour — the DAG, walked one hop
 *    at a time, without hunting for the node on the canvas.
 *
 * Everything above the bodies comes from the **snapshot** and renders immediately: the header,
 * the gates and the chips are on the wire already (#15, #19), so the panel is useful before the
 * fetch lands and stays useful if the fetch fails.
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
  /** The bodies, the attempts and the messages. Null until the fetch lands (`detail.ts`). */
  detail: TaskDetail | null;
  /** Why it did not land. The rest of the panel renders anyway. */
  error: string | null;
  /** Let the task go: the dock returns to the feed. */
  onClose: () => void;
  /** Walk to a neighbour — it *selects*, it does not toggle. */
  onSelectTask: (taskId: string) => void;
};

export function Inspector({ task, gates, tasks, detail, error, onClose, onSelectTask }: InspectorProps) {
  const [showHeartbeats, setShowHeartbeats] = useState(false);

  // What this task waited for, and what waited on it. The forward edges are the task's own
  // `deps`; the back edges are every task in the *database* that names it — a dependent in
  // another inferred run is still a dependent, and dropping it would hide a real edge.
  const dependents = useMemo(
    () => tasks.filter((candidate) => candidate.deps.includes(task.id)).map((candidate) => candidate.id),
    [tasks, task.id]
  );

  // The heartbeat rule is the feed's, and it is applied by the feed's own selector rather than
  // re-implemented: 65% of the traffic carries a `taskId`, so a task's story unfiltered is a
  // heartbeat ticker with the story lost inside it (SPEC §7.7). Their value is *liveness*, and
  // that is already the "last seen" line on the attempts below. The clock comes with it, so every
  // age in this panel is measured from one instant — re-read whenever the detail is, which is
  // whenever the database moved (`detail.ts`).
  const { shown, hidden, now } = useMemo(
    () => viewOf(detail?.messages ?? [], { runId: null, showHeartbeats }),
    [detail, showHeartbeats]
  );

  return (
    <aside data-testid="inspector" aria-label={`Task ${task.title}`} className={DOCK_CLASS}>
      <Header task={task} onClose={onClose} />

      {/* The same dock the feed wears (`dock.ts`) — it *is* the same dock — and the one thing
          that is this panel's own: it scrolls as a whole, because a spec, an attempt history and
          a message list do not divide a fixed height between them in any honest way. */}
      <ScrollArea className="min-h-0 flex-1">
        {/*
          Everything the *route* was going to say, and one honest line instead when it could not
          say it. "No spec was dispatched" would be a lie here: what happened is that nobody knows
          — and the sections below, which are the snapshot's, are unaffected and stay.
        */}
        {error !== null ? (
          <Section title="Spec, result and attempts">
            <p className="text-destructive mt-1 text-[11px]">{error}</p>
          </Section>
        ) : (
          <>
            <Section title="Spec">
              <Body text={detail?.spec ?? null} loading={detail === null} empty="No spec was dispatched with this task." />
            </Section>

            <Section title="Result">
              <Body
                text={detail?.result ?? null}
                loading={detail === null}
                empty="No result yet — nothing has been reported back."
              />
            </Section>

            <Section title={attemptsTitle(detail?.attempts?.length ?? task.attemptCount)}>
              <Attempts attempts={detail?.attempts ?? null} loading={detail === null} now={now} />
            </Section>

            <Section title="Messages">
              <div className="mt-2">
                <HeartbeatToggle showHeartbeats={showHeartbeats} onChange={setShowHeartbeats} hidden={hidden} />
              </div>

              {shown.length === 0 ? (
                <p className="text-muted-foreground mt-2 text-[11px]">
                  {detail === null ? 'Reading…' : 'No message ever mentioned this task.'}
                </p>
              ) : (
                <ol className="mt-2 -mx-4 border-t">
                  {/* Oldest first: a task's messages are a story, and a story starts at the beginning. */}
                  {shown.map((message) => (
                    <li key={message.sequence}>
                      <MessageRow message={message} now={now} />
                    </li>
                  ))}
                </ol>
              )}
            </Section>
          </>
        )}

        {gates.length > 0 && (
          <Section title={gates.length === 1 ? 'Decision gate' : `Decision gates (${gates.length})`}>
            <ul className="mt-2 flex flex-col gap-2">
              {gates.map((gate) => (
                <li key={gate.id}>
                  <GateQA gate={gate} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        <Section title="Depends on">
          <Deps
            testId="deps-in"
            ids={task.deps}
            tasks={tasks}
            onSelectTask={onSelectTask}
            empty="Nothing — this task waited for nobody."
          />
        </Section>

        <Section title="Blocks">
          <Deps
            testId="deps-out"
            ids={dependents}
            tasks={tasks}
            onSelectTask={onSelectTask}
            empty="Nothing — no task in this run waited for it."
          />
        </Section>
      </ScrollArea>
    </aside>
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
function Header({ task, onClose }: { task: Task; onClose: () => void }) {
  return (
    <header className="flex shrink-0 flex-col gap-2 border-b px-4 py-3">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 text-sm leading-snug font-semibold">{task.title}</h2>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onClose}
          title="Close the inspector and go back to the feed"
          aria-label="Close the inspector"
          className="text-muted-foreground -mt-1 -mr-1 size-7 shrink-0 cursor-pointer"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <StatusChip status={task.status} theme={themeOf(task.status)} />
        {task.attemptCount > 1 && (
          <span data-testid="retry-marker" className="text-[11px] font-bold text-amber-700 dark:text-amber-400">
            ↻{task.attemptCount} attempts
          </span>
        )}
        <CopyableId id={task.id} />
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

/** ~1.5 s of "Copied" — long enough to be read, short enough not to become the label. */
const COPIED_MS = 1500;

function CopyableId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      title="Copy the task id"
      // The visible label is the id — which is what a person needs to *see*. What the button
      // does with it has to be said too, and the id stays inside the name so the two agree.
      aria-label={`Copy the task id ${id}`}
      onClick={() => {
        // Absent outside a secure context, which is not this tool's to fix — and the id is
        // right there, selectable, either way.
        void navigator.clipboard?.writeText(id).then(() => setCopied(true));
      }}
      className={cn(CHIP_CLASS, 'max-w-full cursor-pointer text-[10px]')}
    >
      {/* The id in an element of its own: it is a *value* — the thing you paste into a command —
          and not a label with an icon stuck to the end of it. */}
      <code className="truncate font-mono">{id}</code>

      {copied ? (
        // Said out loud, not only shown: the confirmation is the whole feedback of the click.
        <span role="status" className="flex shrink-0 items-center gap-0.5">
          <Check className="size-3" /> copied
        </span>
      ) : (
        <Copy aria-hidden className="size-3 shrink-0" />
      )}
    </button>
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
        'bg-muted text-foreground/90 mt-2 rounded-md p-2.5 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap',
        // The agent wrote prose and it is read as prose — but a spec that is 4 KB of it must not
        // push the sections below it off the panel.
        'max-h-56 overflow-y-auto'
      )}
    >
      {text}
    </pre>
  );
}

/** The count is the headline: `> 1` is the whole retry story, said before the rows are read. */
function attemptsTitle(count: number): string {
  return count > 1 ? `Dispatch attempts (${count})` : 'Dispatch';
}

/**
 * **Every** attempt, oldest first — the ticket's whole reason for existing.
 *
 * The node badge shows the latest attempt because it has room for one. The rows it folded away
 * are the only record that this task was ever retried: who else held it, how many times it
 * failed, and whether the third attempt tripped the circuit breaker (Orca trips it at 3).
 */
function Attempts({ attempts, loading, now }: { attempts: Dispatch[] | null; loading: boolean; now: number }) {
  if (loading) return <p className="text-muted-foreground mt-1 text-[11px]">Reading…</p>;
  if (attempts === null || attempts.length === 0) {
    return <p className="text-muted-foreground mt-1 text-[11px]">Never dispatched — no agent has held this task.</p>;
  }

  return (
    <ol className="mt-2 flex flex-col gap-2">
      {attempts.map((dispatch, index) => (
        <li key={dispatch.id || index} data-testid="attempt" className="bg-muted/40 rounded-md border p-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <b className="text-[11px] font-semibold">
              Attempt {index + 1} of {attempts.length}
            </b>

            <StatusChip status={dispatch.status} theme={dispatchTheme(dispatch.status)} />

            {dispatch.failureCount > 0 && (
              <span data-testid="failure-count" className="text-[11px] font-bold text-red-700 dark:text-red-400">
                ✗{dispatch.failureCount}
              </span>
            )}

            {dispatch.assigneeHandle !== '' && (
              <span
                data-testid="assignee"
                title={dispatch.assigneeHandle}
                className="bg-foreground/85 text-background ml-auto rounded px-1.5 py-px font-mono text-[10px]"
              >
                {shortHandle(dispatch.assigneeHandle)}
              </span>
            )}
          </div>

          <dl className="text-muted-foreground mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            <Fact label="Dispatched" at={dispatch.dispatchedAt} now={now} />
            <Fact label="Completed" at={dispatch.completedAt} now={now} />
            <Fact label="Last failure" at={dispatch.lastFailure} now={now} />
            <Fact label="Last seen" at={dispatch.lastHeartbeatAt} now={now} />
          </dl>
        </li>
      ))}
    </ol>
  );
}

/** One instant, or nothing at all: a row for a timestamp the attempt never had would say nothing. */
function Fact({ label, at, now }: { label: string; at: string | null; now: number }) {
  if (at === null || at === '') return null;

  // The same reader the feed's row ages by (`relative-time.ts`) — including what it does with a
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
        'rounded-lg border p-2.5 text-xs',
        // An open question is the colour of a blocker; an answered one is history, and history
        // is quiet.
        open ? GATE_THEME.surface : 'bg-muted/40 text-foreground/80'
      )}
    >
      <p className="flex gap-1.5 font-semibold whitespace-pre-line">
        {open && <OctagonAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />}
        <span>{gate.question}</span>
      </p>

      {gate.options.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {gate.options.map((option) => (
            <span
              key={option}
              className={cn(
                'rounded-full border px-2 py-px text-[11px] font-medium',
                open ? 'border-gate/60 bg-background/70' : 'bg-background'
              )}
            >
              {option}
            </span>
          ))}
        </div>
      )}

      <p className="mt-1.5 text-[11px]">
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
            className={cn(CHIP_CLASS, 'max-w-full cursor-pointer')}
          >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', themeOf(neighbour.status).dot)} />
            <span className="truncate">{neighbour.title}</span>
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b px-4 py-3 last:border-b-0">
      <h3 className="text-muted-foreground text-[10px] font-semibold tracking-widest uppercase">{title}</h3>
      {children}
    </section>
  );
}

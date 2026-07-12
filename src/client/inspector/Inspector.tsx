import { useEffect, useMemo, useState } from 'react';
import { shortHandle } from '../../shared/handles.ts';
import type { Dispatch, Gate, Task, TaskDetail } from '../../shared/types.ts';
import { colorOf, GATE_COLOR, type StatusColor, UNKNOWN_STATUS_COLOR } from '../canvas/theme.ts';
import { CHIP_STYLE } from '../chip.ts';
import { MessageRow } from '../feed/MessageRow.tsx';
import { viewOf } from '../feed/select.ts';
import { relativeTime } from '../relative-time.ts';

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
  /** The selected run's tasks: a dep is an id, and a person needs a title. */
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
  // `deps`; the back edges are every task that names it — the same edge set the canvas draws.
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
    <aside
      data-testid="inspector"
      aria-label={`Task ${task.title}`}
      style={{
        width: 360,
        flexShrink: 0,
        borderLeft: '1px solid #e4e4e7',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        overflowY: 'auto',
      }}
    >
      <Header task={task} onClose={onClose} />

      {/*
        Everything the *route* was going to say, and one honest line instead when it could not
        say it. "No spec was dispatched" would be a lie here: what happened is that nobody knows
        — and the sections below, which are the snapshot's, are unaffected and stay.
      */}
      {error !== null ? (
        <Section title="Spec, result and attempts">
          <p style={{ ...MUTED_STYLE, color: '#b91c1c' }}>{error}</p>
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

          <Section title={attemptsTitle(detail?.attempts ?? null, task)}>
            <Attempts attempts={detail?.attempts ?? null} loading={detail === null} now={now} />
          </Section>

          <Section title="Messages">
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#3f3f46' }}>
              <input
                type="checkbox"
                checked={showHeartbeats}
                onChange={(changed) => setShowHeartbeats(changed.target.checked)}
              />
              Show heartbeats
              {hidden > 0 && (
                <span style={{ color: '#71717a' }}>
                  ({hidden} {hidden === 1 ? 'heartbeat' : 'heartbeats'} hidden)
                </span>
              )}
            </label>

            {shown.length === 0 ? (
              <p style={MUTED_STYLE}>{detail === null ? 'Reading…' : 'No message ever mentioned this task.'}</p>
            ) : (
              <ol style={{ ...LIST_STYLE, margin: '4px -12px 0' }}>
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
          <ul style={LIST_STYLE}>
            {gates.map((gate) => (
              <li key={gate.id}>
                <GateQA gate={gate} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Depends on">
        <Deps testId="deps-in" ids={task.deps} tasks={tasks} onSelectTask={onSelectTask} empty="Nothing — this task waited for nobody." />
      </Section>

      <Section title="Blocks">
        <Deps testId="deps-out" ids={dependents} tasks={tasks} onSelectTask={onSelectTask} empty="Nothing — no task in this run waited for it." />
      </Section>
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
  const color = colorOf(task.status);

  return (
    <header style={{ padding: '12px 12px 8px', borderBottom: '1px solid #e4e4e7', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h2 style={{ fontSize: 14, margin: 0, flex: 1, minWidth: 0, lineHeight: 1.3 }}>{task.title}</h2>

        <button
          type="button"
          onClick={onClose}
          title="Close the inspector and go back to the feed"
          aria-label="Close the inspector"
          style={{ border: 'none', background: 'none', color: '#71717a', fontSize: 14, cursor: 'pointer', padding: 0 }}
        >
          ✕
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <StatusChip status={task.status} color={color} />
        {task.attemptCount > 1 && (
          <span data-testid="retry-marker" style={{ color: '#b45309', fontWeight: 700, fontSize: 11 }}>
            ↻{task.attemptCount} attempts
          </span>
        )}
        <CopyableId id={task.id} />
      </div>
    </header>
  );
}

/** The raw status string, in its colour — an unknown one is neutral grey and still shown (SPEC §5). */
function StatusChip({ status, color }: { status: string; color: StatusColor }) {
  return (
    <span
      data-testid="status-chip"
      style={{
        background: color.bg,
        border: `1px solid ${color.border}`,
        color: color.text,
        borderRadius: 4,
        padding: '1px 6px',
        fontSize: 11,
        fontWeight: 600,
      }}
    >
      {status}
    </span>
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
      style={{
        ...CHIP_STYLE,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 10,
        maxWidth: '100%',
      }}
    >
      {/* The id in an element of its own: it is a *value* — the thing you paste into a command —
          and not a label with an icon stuck to the end of it. */}
      <code style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{id}</code>

      {copied ? (
        // Said out loud, not only shown: the confirmation is the whole feedback of the click.
        <span role="status" style={{ flexShrink: 0 }}>
          · copied
        </span>
      ) : (
        <span aria-hidden style={{ flexShrink: 0 }}>
          ⧉
        </span>
      )}
    </button>
  );
}

/**
 * A body — the spec, or the result. Two states before there is one to show, and they are
 * different facts: it is on its way, or the task genuinely has none.
 */
function Body({ text, loading, empty }: { text: string | null; loading: boolean; empty: string }) {
  if (loading) return <p style={MUTED_STYLE}>Reading…</p>;
  if (text === null) return <p style={MUTED_STYLE}>{empty}</p>;

  return (
    <pre
      style={{
        margin: '4px 0 0',
        padding: 8,
        borderRadius: 4,
        background: '#f4f4f5',
        color: '#27272a',
        fontSize: 11,
        lineHeight: 1.45,
        // The agent wrote prose and it is read as prose — but a spec that is 4 KB of it must
        // not push the sections below it off the panel.
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 220,
        overflowY: 'auto',
      }}
    >
      {text}
    </pre>
  );
}

function attemptsTitle(attempts: Dispatch[] | null, task: Task): string {
  const count = attempts?.length ?? task.attemptCount;
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
  if (loading) return <p style={MUTED_STYLE}>Reading…</p>;
  if (attempts === null || attempts.length === 0) {
    return <p style={MUTED_STYLE}>Never dispatched — no agent has held this task.</p>;
  }

  return (
    <ol style={LIST_STYLE}>
      {attempts.map((dispatch, index) => (
        <li key={dispatch.id || index} data-testid="attempt" style={ATTEMPT_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 11 }}>
              Attempt {index + 1} of {attempts.length}
            </b>

            <StatusChip status={dispatch.status} color={dispatchColor(dispatch.status)} />

            {dispatch.failureCount > 0 && (
              <span data-testid="failure-count" style={{ color: '#b91c1c', fontWeight: 700, fontSize: 11 }}>
                ✗{dispatch.failureCount}
              </span>
            )}

            {dispatch.assigneeHandle !== '' && (
              <span
                data-testid="assignee"
                title={dispatch.assigneeHandle}
                style={{
                  marginLeft: 'auto',
                  background: '#1e293b',
                  color: '#e2e8f0',
                  borderRadius: 4,
                  padding: '1px 5px',
                  fontFamily: 'ui-monospace, monospace',
                  fontSize: 10,
                }}
              >
                {shortHandle(dispatch.assigneeHandle)}
              </span>
            )}
          </div>

          <dl style={{ margin: '4px 0 0', fontSize: 11, color: '#52525b', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 8px' }}>
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

  const instant = Date.parse(at);

  return (
    <>
      <dt style={{ color: '#a1a1aa' }}>{label}</dt>
      <dd style={{ margin: 0 }} title={Number.isNaN(instant) ? at : new Date(instant).toLocaleString()}>
        {/* An unreadable timestamp reaches the client verbatim (`time.ts`), and is shown
            verbatim rather than as "NaN ago". */}
        {Number.isNaN(instant) ? at : `${relativeTime(now - instant)} ago`}
      </dd>
    </>
  );
}

/**
 * A dispatch status wears the colour of the task status it means, so the panel and the canvas
 * agree: a failed attempt is red, a live one amber, a finished one green. `circuit_broken` is the
 * loudest thing a dispatch row can say — three failures and Orca stopped trying — so it is red too.
 */
function dispatchColor(status: string): StatusColor {
  switch (status) {
    case 'completed':
      return colorOf('completed');
    case 'failed':
    case 'circuit_broken':
      return colorOf('failed');
    case 'dispatched':
      return colorOf('dispatched');
    case 'pending':
      return colorOf('pending');
    default:
      // An Orca that invented a dispatch status still named a real state (SPEC §5).
      return UNKNOWN_STATUS_COLOR;
  }
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
      style={{
        border: `1px solid ${open ? GATE_COLOR.border : '#e4e4e7'}`,
        background: open ? GATE_COLOR.bg : '#fafafa',
        color: open ? GATE_COLOR.text : '#3f3f46',
        borderRadius: 6,
        padding: 8,
        fontSize: 12,
      }}
    >
      <p style={{ margin: 0, fontWeight: 600, whiteSpace: 'pre-line' }}>
        {open && <span aria-hidden>⛔ </span>}
        {gate.question}
      </p>

      {gate.options.length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', margin: '5px 0 0' }}>
          {gate.options.map((option) => (
            <span
              key={option}
              style={{
                padding: '1px 7px',
                borderRadius: 999,
                border: '1px solid #d4d4d8',
                background: '#ffffff',
                fontSize: 11,
              }}
            >
              {option}
            </span>
          ))}
        </div>
      )}

      <p style={{ margin: '5px 0 0', fontSize: 11 }}>
        {open ? (
          <i>Waiting — nobody has answered this yet.</i>
        ) : (
          <>
            <b>Answered:</b> <span style={{ whiteSpace: 'pre-line' }}>{gate.resolution ?? '(no answer was recorded)'}</span>
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
      <p data-testid={testId} style={MUTED_STYLE}>
        {empty}
      </p>
    );
  }

  return (
    <div data-testid={testId} style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {ids.map((id) => {
        const neighbour = tasks.find((candidate) => candidate.id === id);

        return neighbour === undefined ? (
          <span
            key={id}
            title="This task is not in the database any more — a reset deleted it."
            style={{ ...CHIP_STYLE, cursor: 'default', background: '#fafafa', border: '1px solid #e4e4e7', color: '#71717a' }}
          >
            {id} · gone
          </span>
        ) : (
          <button
            key={id}
            type="button"
            onClick={() => onSelectTask(id)}
            title={`${neighbour.status} — show this task`}
            style={{ ...CHIP_STYLE, display: 'flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}
          >
            <span
              aria-hidden
              style={{ width: 7, height: 7, borderRadius: 999, background: colorOf(neighbour.status).border, flexShrink: 0 }}
            />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{neighbour.title}</span>
          </button>
        );
      })}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '10px 12px', borderBottom: '1px solid #f4f4f5' }}>
      <h3 style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: '#71717a', margin: 0 }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

const MUTED_STYLE = { margin: '4px 0 0', fontSize: 11, color: '#71717a' };

const LIST_STYLE = { listStyle: 'none', margin: '6px 0 0', padding: 0, display: 'flex', flexDirection: 'column' as const, gap: 6 };

const ATTEMPT_STYLE = { border: '1px solid #e4e4e7', borderRadius: 6, padding: 8 };

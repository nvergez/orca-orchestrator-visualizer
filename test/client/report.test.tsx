import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CannedApp, type CannedEvent, historyOf, reportOf } from './canned.tsx';
import { FakeMatchMedia, MOBILE_QUERY } from './fake-match-media.ts';
import { App } from '../../src/client/App.tsx';
import type { TaskLoader } from '../../src/client/inspector/detail.ts';
import type { ReportLoader } from '../../src/client/report/query.ts';
import type { CastMember, Dispatch, Meta, Run, Task, TaskDetail, Turn } from '../../src/shared/types.ts';

/**
 * Seam 2 (#12): the **cross-history report** on screen (#70, SPEC §12.4).
 *
 * The panel is deliberately thin — it ranks nothing, filters nothing and pages nothing itself;
 * every one of those is a new query, and the server answers it (`server/report.ts`). So what
 * this suite is *for* is the three things the client owns and could get wrong:
 *
 * 1. **A missing value is said out loud.** "Never dispatched" is the finding a rail of runs can
 *    never show; an empty cell would read as a rendering bug instead.
 * 2. **A control means a query.** A header, a filter, a "load older rows" — each one asks the
 *    server again, and the canned loader here is the server's own `buildReport` (`canned.tsx`),
 *    so a page this suite sees is a page the endpoint would really have served.
 * 3. **A row is a door.** Selecting one loads its complete run and opens the *existing* task
 *    inspector — the report creates no second task-detail truth, which is the whole shape of the
 *    ticket.
 */

const META: Meta = {
  dbPath: '/home/dev/.config/orca/orchestration.db',
  schemaVersion: 5,
  schemaSupport: 'supported',
  degraded: [],
  liveness: 'live',
  orcaPid: 4242,
  dbMtime: '2026-07-11T20:54:00.000Z',
  resetDetected: false,
};

const HANDLE = 'term_9f8e7d6c-1234-4321-8888-aabbccddeeff';
const OTHER_HANDLE = 'term_11112222-1234-4321-8888-aabbccddeeff';
const ALICE = 'term_a11ce000-1234-4321-8888-aabbccddeeff';
const BOB = 'term_b0b00000-1234-4321-8888-aabbccddeeff';

const RUN_ID = `run_${HANDLE}`;
const OTHER_RUN_ID = `run_${OTHER_HANDLE}`;

const DONE = 'task_aaaa0001';
const STALLED = 'task_bbbb0002';
const ELSEWHERE = 'task_cccc0003';

const DISPATCHED_AT = '2026-07-08T12:00:00.000Z';
const COMPLETED_AT = '2026-07-08T12:25:00.000Z';

function member(handle: string, monogram: string, taskIds: string[]): CastMember {
  return { handle, monogram, taskIds, taskCount: taskIds.length, lastHeartbeatAt: null };
}

function run(over: Partial<Run> = {}): Run {
  return {
    id: RUN_ID,
    handle: HANDLE,
    label: 'Ship the visualizer',
    startedAt: '2026-07-08T11:50:00.000Z',
    endedAt: '2026-07-08T12:30:00.000Z',
    taskCount: 2,
    cast: [member(ALICE, 'A1', [DONE])],
    waves: [],
    statusCounts: { pending: 1, ready: 0, dispatched: 0, completed: 1, failed: 0, blocked: 0 },
    live: false,
    hasOpenGates: false,
    edgeCount: 0,
    ...over,
  };
}

function attempt(over: Partial<Dispatch> = {}): Dispatch {
  return {
    id: 'ctx_one',
    assigneeHandle: ALICE,
    status: 'completed',
    failureCount: 0,
    lastFailure: null,
    dispatchedAt: DISPATCHED_AT,
    completedAt: COMPLETED_AT,
    lastHeartbeatAt: null,
    ...over,
  };
}

function task(over: Partial<Task> = {}): Task {
  return {
    id: DONE,
    runId: RUN_ID,
    parentId: null,
    title: 'Ship the report',
    status: 'completed',
    deps: [],
    createdAt: '2026-07-08T11:50:00.000Z',
    completedAt: COMPLETED_AT,
    hasSpec: true,
    hasResult: true,
    dispatch: attempt(),
    attemptCount: 1,
    duration: { clock: 'dispatch', startAt: DISPATCHED_AT, endAt: COMPLETED_AT, complete: true, ms: 25 * 60 * 1000 },
    gate: null,
    ...over,
  };
}

/** The task nothing ever dispatched — the row this whole feature exists to keep. */
function stalled(): Task {
  return task({
    id: STALLED,
    title: 'Waiting on a decision',
    status: 'pending',
    completedAt: null,
    hasResult: false,
    dispatch: null,
    attemptCount: 0,
    duration: undefined,
  });
}

/** A task in a *different* orchestrator — what a report row has to be able to cross into. */
function elsewhere(): Task {
  return task({
    id: ELSEWHERE,
    runId: OTHER_RUN_ID,
    title: 'Another orchestration',
    status: 'completed',
    dispatch: attempt({ id: 'ctx_two', assigneeHandle: BOB }),
    attemptCount: 1,
  });
}

/** The receipt the conversation carries for the completed task — and the row summarizes (#67). */
function resultTurn(): Turn {
  return {
    id: `result:${DONE}`,
    runId: RUN_ID,
    direction: 'in',
    kind: 'result',
    fromHandle: ALICE,
    toHandle: HANDLE,
    at: COMPLETED_AT,
    taskId: DONE,
    subject: 'Ship the report',
    body: 'Done.',
    source: 'tasks.result',
    receipt: [
      { kind: 'branch', value: 'nvergez/70', sources: ['tasks.result · branch'] },
      { kind: 'file', value: 'src/server/report.ts', sources: ['tasks.result · filesModified'] },
    ],
  };
}

function event(over: Partial<CannedEvent> = {}): CannedEvent {
  return {
    seq: 0,
    affected: { all: true, runIds: [], unplaced: false },
    meta: META,
    snapshot: {
      runs: [run(), run({ id: OTHER_RUN_ID, handle: OTHER_HANDLE, label: 'Another orchestrator', taskCount: 1, cast: [member(BOB, 'A1', [ELSEWHERE])] })],
      tasks: [task(), stalled(), elsewhere()],
      gates: [],
      turns: [resultTurn()],
      coordinatorRuns: [],
    },
    messages: [],
    ...over,
  };
}

const NO_DETAIL: TaskLoader = async () => {
  throw new Error('no detail in this suite');
};

function detailFor(id: string): TaskLoader {
  return async () => ({ id, spec: 'The prompt.', result: 'Done.', attempts: [attempt()], receipt: [], completions: [] }) as TaskDetail;
}

/** Open the report, and hand back its panel. */
async function open(): Promise<HTMLElement> {
  await userEvent.click(await screen.findByTestId('open-report'));
  return screen.getByTestId('report');
}

function rows(): HTMLElement[] {
  return screen.getAllByTestId('report-row');
}

function rowFor(taskId: string): HTMLElement {
  const found = rows().find((element) => element.dataset.task === taskId);
  if (!found) throw new Error(`no report row for ${taskId}`);
  return found;
}

describe('the report, on screen', () => {
  it('lists one row per retained task, across every orchestrator', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);

    const panel = await open();

    // Across runs — which is the whole difference between this and the canvas. The rail lists
    // orchestrators; this lists the work, whoever coordinated it.
    expect(rows()).toHaveLength(3);
    expect(within(panel).getByTestId('report-total')).toHaveTextContent('3 of 3');
    expect(rowFor(ELSEWHERE)).toHaveTextContent('Another orchestrator');
  });

  it('says "never dispatched" out loud, rather than leaving a cell blank', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    await open();

    const row = rowFor(STALLED);

    // The finding this feature exists for. A blank cell reads as a bug; the words read as the
    // answer — and the duration beside it is *unknown*, never a zero (#66).
    expect(within(row).getByText('never dispatched')).toBeVisible();
    expect(within(row).getAllByTestId('report-missing').map((each) => each.textContent)).toEqual([
      'none',
      'never dispatched',
      'unknown',
      'none recognized',
    ]);
    expect(within(row).queryByTestId('report-duration')).not.toBeInTheDocument();
  });

  it('shows the agent by the monogram the canvas uses, the honest duration, and the compact outcome', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    await open();

    const row = rowFor(DONE);

    expect(within(row).getByText('A1')).toBeVisible();
    // #66's observation, read the one way this tool reads it (`duration.tsx`).
    expect(within(row).getByTestId('report-duration')).toHaveTextContent('25m');
    // #67's recognized facts, as chips — the same reading the conversation shows, capped.
    expect(within(row).getByTestId('report-outcome')).toHaveTextContent('nvergez/70');
    expect(within(row).getByRole('button', { name: /copy the file path src\/server\/report\.ts/i })).toBeVisible();
  });
});

describe('ranking and filtering are the server’s — the panel only asks', () => {
  it('re-asks with a new sort when a column header is clicked, and again when it is clicked twice', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    // Default: the most recently dispatched first — and these two went out at the same instant,
    // so the task id breaks the tie (ascending, whichever way the sort points), which is what
    // makes the order *total* and the pages tile. The never-dispatched row is last, because
    // unknown is an absence rather than the earliest instant in history (`report.ts`).
    expect(rows().map((row) => row.dataset.task)).toEqual([DONE, ELSEWHERE, STALLED]);

    await userEvent.click(within(panel).getByTestId('report-sort-title'));

    // A new key starts at its useful end — a title is looked up, so it starts ascending.
    expect(rows().map((row) => row.dataset.task)).toEqual([ELSEWHERE, DONE, STALLED]);
    const header = within(panel).getByTestId('report-sort-title').closest('th')!;
    expect(header).toHaveAttribute('aria-sort', 'ascending');

    await userEvent.click(within(panel).getByTestId('report-sort-title'));

    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(rows().map((row) => row.dataset.task)).toEqual([STALLED, DONE, ELSEWHERE]);
  });

  it('filters to one orchestrator', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    await userEvent.selectOptions(within(panel).getByTestId('report-filter-run'), OTHER_RUN_ID);

    expect(rows().map((row) => row.dataset.task)).toEqual([ELSEWHERE]);
    expect(within(panel).getByTestId('report-total')).toHaveTextContent('1 of 1');
  });

  it('filters the never-dispatched work in by name — a missing value is a value', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    await userEvent.selectOptions(within(panel).getByTestId('report-filter-dispatch'), 'missing');

    expect(rows().map((row) => row.dataset.task)).toEqual([STALLED]);

    // …and the outcome filter asks the same kind of question of the other absence.
    await userEvent.click(within(panel).getByTestId('report-clear'));
    await userEvent.selectOptions(within(panel).getByTestId('report-filter-outcome'), 'present');
    expect(rows().map((row) => row.dataset.task)).toEqual([DONE]);
  });

  it('says so when the filters match nothing, rather than showing an empty table', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    await userEvent.selectOptions(within(panel).getByTestId('report-filter-run'), OTHER_RUN_ID);
    await userEvent.selectOptions(within(panel).getByTestId('report-filter-dispatch'), 'missing');

    expect(screen.queryAllByTestId('report-row')).toHaveLength(0);
    expect(within(panel).getByTestId('report-empty')).toHaveTextContent(/no retained task matches these filters/i);
  });

  it('filters by a cast member, and lists them by the monogram of the run that named them', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    const agents = within(panel).getByTestId('report-filter-agent');
    expect(within(agents).getByRole('option', { name: /A1 · Ship the visualizer/ })).toBeInTheDocument();

    await userEvent.selectOptions(agents, BOB);
    expect(rows().map((row) => row.dataset.task)).toEqual([ELSEWHERE]);
  });

  it('offers "no agent on record" in the same select — the column’s missing value is findable', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    // One control, two questions: which agent, and *no agent at all*. A select that only offered
    // handles could never ask the second, and the second is the one a stalled task answers.
    await userEvent.selectOptions(within(panel).getByTestId('report-filter-agent'), 'none');

    expect(rows().map((row) => row.dataset.task)).toEqual([STALLED]);
  });
});

/** 60 tasks in one run: one page of 50, and an explicit way down to the other 10. */
function manyTasks(): CannedEvent {
  const tasks = Array.from({ length: 60 }, (_, index) =>
    task({
      id: `task_${String(index).padStart(4, '0')}`,
      title: `Work item ${index}`,
      dispatch: attempt({ id: `ctx_${index}`, dispatchedAt: new Date(Date.parse(DISPATCHED_AT) + index * 60_000).toISOString() }),
    })
  );

  return event({
    snapshot: { runs: [run({ taskCount: 60 })], tasks, gates: [], turns: [], coordinatorRuns: [] },
  });
}

describe('paging', () => {
  it('bounds the first page and offers the rest explicitly, never silently', async () => {
    render(<CannedApp event={manyTasks()} loadTask={NO_DETAIL} />);
    const panel = await open();

    expect(rows()).toHaveLength(50);
    // The count is what the *filters* matched, not what is on screen — so a reader knows the rest
    // is there before they go looking for it.
    expect(within(panel).getByTestId('report-total')).toHaveTextContent('50 of 60');

    await userEvent.click(within(panel).getByTestId('report-more'));

    expect(rows()).toHaveLength(60);
    // History ends where the button stops rendering — which is where the server said it ends.
    expect(within(panel).queryByTestId('report-more')).not.toBeInTheDocument();
  });
});

describe('a page that did not arrive says so', () => {
  it('does not let "Load older rows" fail in silence', async () => {
    const world = manyTasks();
    const loader = reportOf(world);
    // The first page lands; the page behind the cursor does not. A button that quietly did nothing
    // would leave the reader believing those rows are not there — which is the one thing "older
    // history is explicit" (SPEC §12.4) exists to prevent.
    const flaky: ReportLoader = (search) =>
      search.includes('cursor=') ? Promise.reject(new Error('the wire hung up')) : loader(search);

    render(<App event={world} loadTask={NO_DETAIL} loadHistory={historyOf(world)} loadReport={flaky} />);
    const panel = await open();

    await userEvent.click(within(panel).getByTestId('report-more'));

    expect(await within(panel).findByTestId('report-more-failed')).toHaveTextContent(/did not arrive/i);
    // The rows that did land are still there, and the button is still standing: pressing it again
    // *is* the retry, because the cursor never moved.
    expect(rows()).toHaveLength(50);
    expect(within(panel).getByTestId('report-more')).toBeVisible();
  });
});

describe('a row is a door into the existing story', () => {
  it('loads the row’s own orchestrator and opens the existing task inspector', async () => {
    render(<CannedApp event={event()} loadTask={detailFor(ELSEWHERE)} />);
    const panel = await open();

    // The rail opened on the most recently active run, and this row belongs to the *other* one:
    // the report ranks all of retained history, so a row routinely names a run the client is not
    // looking at. Selecting it has to load that run whole — and then get out of the way.
    await userEvent.click(within(panel).getByRole('button', { name: /Open Another orchestration/i }));

    expect(screen.queryByTestId('report')).not.toBeInTheDocument();

    const inspector = await screen.findByTestId('inspector');
    expect(within(inspector).getByText('Another orchestration')).toBeVisible();

    // The rail moved with it: one selected run, one canvas, one story — the report created no
    // second task detail, it walked the reader into the one that was already there.
    await waitFor(() => {
      const selected = screen.getAllByTestId('run-row').find((row) => row.getAttribute('aria-current') === 'true');
      expect(selected?.dataset.run).toBe(OTHER_RUN_ID);
    });
  });

  it('closes on Escape without touching the selection', async () => {
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    await open();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByTestId('report')).not.toBeInTheDocument();
    expect(screen.queryByTestId('inspector')).not.toBeInTheDocument();
  });
});

/**
 * **The folded report** (`docs/design/mobile.md`). Nine columns do not fit a 390px phone, and the
 * page may not scroll sideways to hide it — so below `lg` the same rows become cards. The opt-in
 * is the suite-wide one: no `matchMedia` means desktop, which is why every test above renders the
 * table without knowing this one exists.
 */
describe('the folded report', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function onAPhone(): void {
    const media = new FakeMatchMedia();
    media.set(MOBILE_QUERY, true);
    vi.stubGlobal('matchMedia', media.matchMedia);
  }

  it('keeps every fact — the duration, the failures and the outcome do not go off the side', async () => {
    onAPhone();
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    await open();

    // No table at all: the facts are stacked and labelled, in the same order, out of the same row.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    const row = rowFor(DONE);
    expect(within(row).getByTestId('report-duration')).toHaveTextContent('25m');
    expect(within(row).getByTestId('report-outcome')).toHaveTextContent('nvergez/70');
    expect(within(row).getByText('A1')).toBeVisible();

    // …and the missing value is still said out loud, which is the thing a narrow screen would
    // have been most tempted to drop.
    expect(within(rowFor(STALLED)).getByText('never dispatched')).toBeVisible();
  });

  it('sorts from the same buttons, under the same names', async () => {
    onAPhone();
    render(<CannedApp event={event()} loadTask={NO_DETAIL} />);
    const panel = await open();

    await userEvent.click(within(panel).getByTestId('report-sort-title'));
    expect(rows().map((row) => row.dataset.task)).toEqual([ELSEWHERE, DONE, STALLED]);

    await userEvent.click(within(panel).getByTestId('report-sort-title'));
    expect(rows().map((row) => row.dataset.task)).toEqual([STALLED, DONE, ELSEWHERE]);
  });

  it('walks a card into the run and the inspector, exactly as the table does', async () => {
    onAPhone();
    render(<CannedApp event={event()} loadTask={detailFor(ELSEWHERE)} />);
    const panel = await open();

    await userEvent.click(within(panel).getByRole('button', { name: /Open Another orchestration/i }));

    expect(screen.queryByTestId('report')).not.toBeInTheDocument();
    const inspector = await screen.findByTestId('inspector');
    expect(within(inspector).getByText('Another orchestration')).toBeVisible();
    // The dock band opened under it — an inspector behind a collapsed handle is an inspector the
    // reader has to go looking for (`App.tsx`, `openReportRow`).
    expect(screen.getByTestId('dock-band-toggle')).toHaveAttribute('aria-expanded', 'true');
  });
});

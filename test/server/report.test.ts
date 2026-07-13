import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReportPage, ReportRow } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Seam 1 (#12): the **cross-history dispatch report** of #70, over real HTTP against a real
 * fixture database (SPEC §14.4, §14.5).
 *
 * The report is the one surface in this tool that reads *across* orchestrator runs, and the
 * temptation it exists to refuse is to become a second graph of everything. It is a table: one
 * row per retained task, ranked and searched on the server, and a click on a row is an entry
 * into the ordinary selected-run canvas and the ordinary inspector.
 *
 * What these tests hold it to:
 *
 * - **Every retained task is a row, including the ones nothing ever dispatched.** Stalled work is
 *   precisely what a search of history is for, and it is the work a rail of runs can never show
 *   you. Those rows carry an explicit missing-dispatch value rather than a blank.
 * - **A missing fact is missing, and it is filterable as missing.** No zeroes, no epochs, no
 *   invented monograms — and `dispatch=missing` / `outcome=missing` ask for those rows by name.
 * - **The order is total, and the pages tile.** Two reads of an unchanged database return the
 *   same pages; a sort tie is broken by task id, ascending, whichever way the sort points.
 * - **A query it cannot honour is refused.** An unknown sort key answered with the default one
 *   would show a different slice of history than the one asked for, and say nothing (SPEC §3).
 */

const AT = new Date('2026-07-08T12:00:00Z');
const MINUTE = 60_000;

const COORDINATOR = handleFor('coordinator');
const ALICE = handleFor('alice');
const BOB = handleFor('bob');

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

function at(offsetMs: number): Date {
  return new Date(AT.getTime() + offsetMs);
}

async function report(query = ''): Promise<ReportPage> {
  const response = await harness!.report(query);
  expect(response.status).toBe(200);
  return (await response.json()) as ReportPage;
}

async function refused(query: string): Promise<string> {
  const response = await harness!.report(query);
  expect(response.status).toBe(400);
  return ((await response.json()) as { error: string }).error;
}

/**
 * The fixture builder writes real timestamps, so a column holding something that is *not* one has
 * to be forged — the `corruptPayload` trick of the receipts suite, pointed at the two instants an
 * attempt can be dated by (`tasks.ts`: `dispatched_at`, else `created_at`).
 */
function unreadableInstants(dbPath: string, dispatchId: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE dispatch_contexts SET dispatched_at = ?, created_at = ? WHERE id = ?').run(
      'the beginning of time',
      'the beginning of time',
      dispatchId
    );
  } finally {
    db.close();
  }
}

function row(page: ReportPage, taskId: string): ReportRow {
  const found = page.rows.find((candidate) => candidate.taskId === taskId);
  if (found === undefined) throw new Error(`no row for ${taskId} in the report`);
  return found;
}

/**
 * One orchestrator, and the three shapes a row can have: work that finished, work that was
 * retried, and work that was **never dispatched at all**.
 */
function corpus(): FixtureBuilder {
  return (
    new FixtureBuilder()
      // Dispatched, completed, and it handed back a receipt.
      .task({
        id: 'task_done',
        handle: COORDINATOR,
        title: 'Ship the report',
        status: 'completed',
        result: '{"branch":"nvergez/70","filesModified":["a.ts","b.ts"],"reportPath":"docs/report.md"}',
        spec: 'a very long agent prompt',
        createdAt: at(0),
        completedAt: at(30 * MINUTE),
      })
      .dispatch({
        taskId: 'task_done',
        assigneeHandle: ALICE,
        status: 'completed',
        dispatchedAt: at(5 * MINUTE),
        completedAt: at(25 * MINUTE),
      })
      // Retried: two attempts, a cumulative failure count, and a second worker.
      .task({
        id: 'task_retried',
        handle: COORDINATOR,
        title: 'Fix the flake',
        status: 'failed',
        createdAt: at(1 * MINUTE),
      })
      .dispatch({
        id: 'ctx_first',
        taskId: 'task_retried',
        assigneeHandle: ALICE,
        status: 'failed',
        failureCount: 1,
        dispatchedAt: at(2 * MINUTE),
        completedAt: at(4 * MINUTE),
      })
      .dispatch({
        id: 'ctx_second',
        taskId: 'task_retried',
        assigneeHandle: BOB,
        status: 'failed',
        // Cumulative: the breaker counted 1 then 2. The task failed **twice**, not three times.
        failureCount: 2,
        dispatchedAt: at(6 * MINUTE),
        completedAt: at(9 * MINUTE),
      })
      // Never dispatched. No agent, no dispatch instant, no duration — and still a row.
      .task({
        id: 'task_stalled',
        handle: COORDINATOR,
        title: 'Waiting on a decision',
        status: 'pending',
        createdAt: at(2 * MINUTE),
      })
  );
}

describe('one row per retained task', () => {
  it('carries the run, the title, the latest agent, the dispatch time, the duration, the attempts, the failures and the status', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const page = await report();

    expect(page.total).toBe(3);
    expect(page.rows.map((each) => each.taskId).sort()).toEqual(['task_done', 'task_retried', 'task_stalled']);

    const done = row(page, 'task_done');
    expect(done).toMatchObject({
      runId: `run_${COORDINATOR}`,
      title: 'Ship the report',
      status: 'completed',
      // The cast's own numbering (`cast.ts`), so the row and the canvas name one agent alike.
      agent: { handle: ALICE, monogram: 'A1' },
      dispatchedAt: at(5 * MINUTE).toISOString(),
      attemptCount: 1,
      failureCount: 0,
    });
    // The run's label, so a row names its orchestrator without a second fetch.
    expect(done.runLabel).toBe(row(page, 'task_retried').runLabel);

    // The duration is #66's observation, whole — the clock it read is on the wire beside the
    // number, because "20 minutes" of dispatch is a different fact from 20 minutes of task span.
    expect(done.duration).toEqual({
      clock: 'dispatch',
      startAt: at(5 * MINUTE).toISOString(),
      endAt: at(25 * MINUTE).toISOString(),
      complete: true,
      ms: 20 * MINUTE,
    });
  });

  it('counts a retried task’s failures without adding its retries’ running totals together', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const retried = row(await report(), 'task_retried');

    // `dispatch_contexts.failure_count` is **cumulative** — the circuit breaker counts up in it.
    // The attempts hold 1 and 2, and the honest answer is 2: summing them would report 3 failures
    // for a task that failed twice, and every retry would inflate the next number (SPEC §14.4).
    expect(retried.failureCount).toBe(2);
    expect(retried.attemptCount).toBe(2);
    // The **latest** attempt's assignee: the one the node badge shows, and the one still holding it.
    expect(retried.agent).toEqual({ handle: BOB, monogram: 'A2' });
  });

  it('keeps a task nothing ever dispatched, with an explicit missing-dispatch value', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const stalled = row(await report(), 'task_stalled');

    // The whole reason this row exists. A rail of runs cannot show you the work that never
    // started; this is where it is, and it says so rather than showing a blank or a zero.
    expect(stalled.attemptCount).toBe(0);
    expect(stalled.agent).toBeNull();
    expect(stalled.dispatchedAt).toBeNull();
    expect(stalled.failureCount).toBe(0);

    // No dispatch, no completion: nothing here supports a duration, and absence is the honest
    // value — never `0`, never the epoch (#66).
    expect(stalled.duration).toBeUndefined();
    expect(stalled.outcome).toBeUndefined();
  });

  it('summarizes the recognized outcome, capped, and says how many facts the cap cut', async () => {
    harness = await serve(
      corpus()
        .message({
          type: 'worker_done',
          fromHandle: ALICE,
          toHandle: COORDINATOR,
          subject: 'Done',
          body: 'Shipped.',
          payload: {
            taskId: 'task_done',
            prUrl: 'https://gitlab.example.com/team/repo/-/merge_requests/3',
            branch: 'nvergez/70',
          },
          createdAt: at(26 * MINUTE),
        })
        .write(tempDbPath())
    );

    const done = row(await report(), 'task_done');

    // Both evidence columns, merged with provenance (#67): the branch both of them stated is one
    // fact wearing two sources — the report deduplicates the *presentation*, never the provenance.
    const branch = done.outcome!.find((fact) => fact.kind === 'branch')!;
    expect(branch.value).toBe('nvergez/70');
    expect(branch.sources).toEqual(['tasks.result · branch', 'worker_done.payload · branch']);

    // A row is a row: three facts, and the count of what was cut rides with them, so the cap is
    // never silent. The uncapped receipt is the inspector's (`GET /api/task/:id`).
    expect(done.outcome).toHaveLength(3);
    expect(done.outcome!.map((fact) => fact.kind)).toEqual(['link', 'branch', 'report']);
    expect(done.outcomeOmitted).toBe(2); // the two files
  });

  it('never carries the bodies — the report is a ranking instrument, not a second task detail', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const page = await report();

    // The 172 KB of spec text the snapshot exists to not send (SPEC §6.3) does not come back in
    // through the report either. What a row shows of an outcome is the recognized facts, capped.
    expect(JSON.stringify(page)).not.toContain('a very long agent prompt');
    // …and no dependency edges: the report draws no graph, and carries nothing to draw one with.
    expect(JSON.stringify(page)).not.toContain('deps');
  });
});

/** 120 tasks, one per minute, each with an attempt — enough to page three times over. */
function manyTasks(count: number): FixtureBuilder {
  const builder = new FixtureBuilder();

  for (let index = 0; index < count; index++) {
    const id = `task_${String(index).padStart(3, '0')}`;
    builder
      .task({ id, handle: COORDINATOR, title: `Work item ${index}`, status: 'completed', createdAt: at(index * MINUTE) })
      .dispatch({
        taskId: id,
        assigneeHandle: ALICE,
        status: 'completed',
        dispatchedAt: at(index * MINUTE),
        completedAt: at(index * MINUTE + 60_000),
      });
  }

  return builder;
}

describe('paging, and the total order under it', () => {
  it('bounds the first page, and tiles the rest with no duplicate and no omission', async () => {
    harness = await serve(manyTasks(120).write(tempDbPath()));

    const first = await report();
    expect(first.rows).toHaveLength(50);
    expect(first.total).toBe(120); // Every matching row, not this page's — "1–50 of 120".
    expect(first.nextCursor).not.toBeNull();

    const second = await report(`cursor=${encodeURIComponent(first.nextCursor!)}`);
    const third = await report(`cursor=${encodeURIComponent(second.nextCursor!)}`);

    expect(second.rows).toHaveLength(50);
    expect(third.rows).toHaveLength(20);
    // History ends where the cursor stops being minted — there is no silent cutoff to fall off.
    expect(third.nextCursor).toBeNull();

    const walked = [...first.rows, ...second.rows, ...third.rows].map((each) => each.taskId);
    expect(new Set(walked).size).toBe(120);
    // Default order: the most recently dispatched work first.
    expect(walked[0]).toBe('task_119');
    expect(walked.at(-1)).toBe('task_000');
  });

  it('returns the same pages twice from an unchanged database', async () => {
    harness = await serve(manyTasks(60).write(tempDbPath()));

    const once = await report();
    const twice = await report();
    expect(twice.rows).toEqual(once.rows);
    expect(twice.nextCursor).toBe(once.nextCursor);

    const next = await report(`cursor=${encodeURIComponent(once.nextCursor!)}`);
    const again = await report(`cursor=${encodeURIComponent(twice.nextCursor!)}`);
    expect(again.rows).toEqual(next.rows);
  });

  it('breaks a tie by task id, ascending, whichever way the sort points', async () => {
    // Every one of these was dispatched at the same instant and ran for the same minute: on
    // dispatch time, on duration, on attempts and on failures they are *equal*. Without a
    // tie-break the pages would fall differently on two reads of an unchanged database — a run
    // duplicated into two pages, or dropped from both.
    const builder = new FixtureBuilder();
    for (const suffix of ['c', 'a', 'b']) {
      builder
        .task({ id: `task_${suffix}`, handle: COORDINATOR, title: 'Same', status: 'completed', createdAt: at(0) })
        .dispatch({
          taskId: `task_${suffix}`,
          assigneeHandle: ALICE,
          status: 'completed',
          dispatchedAt: at(MINUTE),
          completedAt: at(2 * MINUTE),
        });
    }
    harness = await serve(builder.write(tempDbPath()));

    const descending = await report('sort=dispatched&dir=desc');
    const ascending = await report('sort=dispatched&dir=asc');

    // The id tie-break is not part of what the reader asked to rank by — it is what makes the
    // ranking a total order. So it does not flip with the direction: equal rows keep their order.
    expect(descending.rows.map((each) => each.taskId)).toEqual(['task_a', 'task_b', 'task_c']);
    expect(ascending.rows.map((each) => each.taskId)).toEqual(['task_a', 'task_b', 'task_c']);
  });
});

describe('sorting', () => {
  it('ranks by duration, and leaves an unknown duration out of the ranking rather than calling it zero', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const longest = await report('sort=duration&dir=desc');
    const shortest = await report('sort=duration&dir=asc');

    // `task_done` ran 20 minutes, `task_retried`'s latest attempt 3, and `task_stalled` has no
    // observation at all. Unknown sorts **last in both directions**: a task with no duration did
    // not run for zero milliseconds, and it must neither top a descending sort nor bottom an
    // ascending one as if it were the quickest thing in the database (#66).
    expect(longest.rows.map((each) => each.taskId)).toEqual(['task_done', 'task_retried', 'task_stalled']);
    expect(shortest.rows.map((each) => each.taskId)).toEqual(['task_retried', 'task_done', 'task_stalled']);
  });

  it('ranks by attempts, by failures and by title', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    expect((await report('sort=attempts&dir=desc')).rows[0]!.taskId).toBe('task_retried');
    expect((await report('sort=failures&dir=desc')).rows[0]!.taskId).toBe('task_retried');
    expect((await report('sort=title&dir=asc')).rows.map((each) => each.title)).toEqual([
      'Fix the flake',
      'Ship the report',
      'Waiting on a decision',
    ]);
  });

  it('keeps a never-dispatched row in a dispatch-time sort, at the end', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const rows = (await report('sort=dispatched&dir=asc')).rows.map((each) => each.taskId);

    // `task_done` went out at +5m; `task_retried`'s **latest** attempt — the one the row shows —
    // at +6m. And ascending by dispatch time, the row with *no* dispatch time is still there:
    // last, because unknown is an absence and not the earliest instant in history.
    expect(rows).toEqual(['task_done', 'task_retried', 'task_stalled']);
  });
});

describe('filtering — and a missing value is filterable as missing', () => {
  it('filters by run', async () => {
    const other = handleFor('other-orchestrator');
    harness = await serve(
      corpus()
        .task({ id: 'task_elsewhere', handle: other, title: 'Another orchestration', createdAt: at(3 * MINUTE) })
        .write(tempDbPath())
    );

    expect((await report()).total).toBe(4);

    const page = await report(`run=${encodeURIComponent(`run_${other}`)}`);
    expect(page.total).toBe(1);
    expect(page.rows[0]!.taskId).toBe('task_elsewhere');
  });

  it('filters by status — including a status this build has never heard of', async () => {
    harness = await serve(
      new FixtureBuilder({ allowUnknownEnums: true })
        .task({ id: 'task_strange', handle: COORDINATOR, status: 'quarantined', createdAt: at(0) })
        .task({ id: 'task_open', handle: COORDINATOR, status: 'pending', createdAt: at(MINUTE) })
        .write(tempDbPath())
    );

    // Verbatim, all the way through: a status the tool cannot colour is still a status a reader
    // can search for, and a task missing from the report is a worse lie than an odd word in it.
    const page = await report('status=quarantined');
    expect(page.rows.map((each) => each.taskId)).toEqual(['task_strange']);
  });

  it('filters by cast member, on the handle of the attempt the row shows', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    // Alice held `task_retried` first and lost it to Bob on the retry. The row shows the latest
    // attempt, and the filter matches what the row shows — anything else would return rows whose
    // agent column names somebody else.
    const bobs = await report(`cast=${encodeURIComponent(BOB)}`);
    expect(bobs.rows.map((each) => each.taskId)).toEqual(['task_retried']);

    const alices = await report(`cast=${encodeURIComponent(ALICE)}`);
    expect(alices.rows.map((each) => each.taskId)).toEqual(['task_done']);
  });

  it('reads a repeated filter as a list, rather than honouring the first and dropping the rest', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    // A repeated key in a query string *is* a list, and answering `?cast=alice&cast=bob` with only
    // Alice's rows would be the silent ignore this endpoint refuses everywhere else.
    const both = await report(`cast=${encodeURIComponent(ALICE)}&cast=${encodeURIComponent(BOB)}`);
    expect(both.rows.map((each) => each.taskId).sort()).toEqual(['task_done', 'task_retried']);
  });

  it('filters the never-dispatched work in, and out', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    const stalled = await report('dispatch=missing');
    expect(stalled.rows.map((each) => each.taskId)).toEqual(['task_stalled']);

    const dispatched = await report('dispatch=present');
    expect(dispatched.rows.map((each) => each.taskId).sort()).toEqual(['task_done', 'task_retried']);
  });

  it('finds a dispatched task whose dispatch instant nothing can read — missing is missing, however it went missing', async () => {
    // An attempt whose timestamps are not timestamps. `time.ts` passes an unparseable column
    // through **verbatim** rather than dropping the row (SPEC §5), so the row is here and shows
    // what the column held — but no clock can place it, so the sort cannot rank it and a range
    // cannot contain it. The filter named after the dispatch time therefore has to call it
    // *missing*, or the report renders a value that nothing at all can ask for (SPEC §14.4).
    const dbPath = corpus()
      .dispatch({
        id: 'ctx_unreadable',
        taskId: 'task_stalled',
        assigneeHandle: ALICE,
        status: 'dispatched',
        dispatchedAt: at(3 * MINUTE),
      })
      .write(tempDbPath());
    unreadableInstants(dbPath, 'ctx_unreadable');
    harness = await serve(dbPath);

    const missing = await report('dispatch=missing');
    const row = missing.rows.find((each) => each.taskId === 'task_stalled')!;

    // Not never-dispatched — an attempt exists, and the row says so from the other side.
    expect(row.attemptCount).toBe(1);
    expect(row.dispatchedAt).toBe('the beginning of time');
    // …and it is not in the present half, nor in a range that spans the whole corpus.
    expect((await report('dispatch=present')).rows.map((each) => each.taskId)).not.toContain('task_stalled');
    const ranged = await report(`from=${at(-MINUTE).toISOString()}&to=${at(60 * MINUTE).toISOString()}`);
    expect(ranged.rows.map((each) => each.taskId)).not.toContain('task_stalled');
  });

  it('finds a task no terminal is on record as holding — the agent column’s own missing value', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    // `task_stalled` was never dispatched, so no `assignee_handle` names anybody for it. The Agent
    // column renders "none"; `agent=missing` is what asks for exactly the rows that do.
    const none = await report('agent=missing');
    expect(none.rows.map((each) => each.taskId)).toEqual(['task_stalled']);

    const named = await report('agent=present');
    expect(named.rows.map((each) => each.taskId).sort()).toEqual(['task_done', 'task_retried']);
  });

  it('filters by outcome presence — which is "nothing recognized", not "nothing produced"', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    expect((await report('outcome=present')).rows.map((each) => each.taskId)).toEqual(['task_done']);
    expect((await report('outcome=missing')).rows.map((each) => each.taskId).sort()).toEqual([
      'task_retried',
      'task_stalled',
    ]);
  });

  it('filters by a time range on the dispatch clock, and refuses to place a row that has no dispatch instant in it', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    // `task_retried` was dispatched at +6m (its latest attempt), `task_done` at +5m.
    const early = await report(`from=${at(0).toISOString()}&to=${at(5 * MINUTE).toISOString()}`);
    expect(early.rows.map((each) => each.taskId)).toEqual(['task_done']);

    const late = await report(`from=${at(6 * MINUTE).toISOString()}`);
    expect(late.rows.map((each) => each.taskId)).toEqual(['task_retried']);

    // The range reads the **dispatch** clock, and a task with no dispatch instant cannot be shown
    // to be inside it — so a range leaves it out. It is not lost: `dispatch=missing` is where it
    // is asked for by name, which is what "a missing value stays filterable" means.
    const everything = await report(`from=${at(-MINUTE).toISOString()}&to=${at(60 * MINUTE).toISOString()}`);
    expect(everything.rows.map((each) => each.taskId)).not.toContain('task_stalled');
    expect((await report('dispatch=missing')).rows.map((each) => each.taskId)).toContain('task_stalled');
  });

  it('pages a filtered order with the filter still on it', async () => {
    harness = await serve(manyTasks(60).write(tempDbPath()));

    const first = await report('sort=title&dir=asc');
    const second = await report(`sort=title&dir=asc&cursor=${encodeURIComponent(first.nextCursor!)}`);

    expect(first.rows).toHaveLength(50);
    expect(second.rows).toHaveLength(10);
    // Titles are `Work item 0` … `Work item 59`, and the string order is the one asked for.
    expect(second.rows.at(-1)!.title).toBe('Work item 9');
    expect(new Set([...first.rows, ...second.rows].map((each) => each.taskId)).size).toBe(60);
  });
});

describe('a query this report cannot honour is refused, never quietly replaced', () => {
  it('refuses an unknown sort key, direction or presence value', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    // Answering with the default sort would show the reader a slice of history they did not ask
    // for, and nothing on screen would say so (SPEC §3, the flag-that-does-not-work rule).
    expect(await refused('sort=cost')).toMatch(/not a sort this report knows/i);
    expect(await refused('dir=sideways')).toMatch(/not a dir this report knows/i);
    expect(await refused('dispatch=maybe')).toMatch(/not a dispatch this report knows/i);
    expect(await refused('outcome=maybe')).toMatch(/not an? outcome this report knows/i);
  });

  it('refuses a filter it does not have, rather than answering the unfiltered report under it', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    // `?runId=` is a typo for `?run=`, and every retained task answered under it looks exactly
    // like a filter that matched everything. A query string this endpoint half-understands is one
    // it must not answer — the same rule the bad values above are refused by.
    expect(await refused(`runId=${encodeURIComponent(`run_${COORDINATOR}`)}`)).toMatch(
      /not a filter this report knows/i
    );
  });

  it('refuses a range endpoint that is not an instant, and a range that ends before it starts', async () => {
    harness = await serve(corpus().write(tempDbPath()));

    expect(await refused('from=last%20tuesday')).toMatch(/not a readable instant/i);
    expect(await refused(`from=${at(MINUTE).toISOString()}&to=${at(0).toISOString()}`)).toMatch(
      /ends before it starts/i
    );
  });

  it('refuses a cursor it never minted, and one minted under a different sort', async () => {
    harness = await serve(manyTasks(60).write(tempDbPath()));

    expect(await refused('cursor=%7Bnot-json')).toMatch(/not a report cursor/i);

    const page = await report('sort=dispatched&dir=desc');
    // A keyset position means nothing in an order it was not measured in: honouring it would
    // hand back rows from the middle of a ranking the reader is no longer looking at.
    const message = await refused(`sort=title&dir=asc&cursor=${encodeURIComponent(page.nextCursor!)}`);
    expect(message).toMatch(/cut under sort=dispatched/i);
  });
});

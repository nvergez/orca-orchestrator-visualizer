import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { TaskDetail, Turn } from '../../src/shared/types.ts';
import { FixtureBuilder, handleFor } from '../fixtures/builder.ts';
import { tempDbPath } from '../fixtures/temp-dir.ts';
import { type Harness, serve } from './harness.ts';

/**
 * Outcome receipts over the wire (#67, SPEC §12.4) — seam 1, real HTTP against a real
 * fixture database.
 *
 * The reader itself is proven pure (`receipt.test.ts`); what this suite pins is the
 * *contract*: which parts of the wire carry a receipt, how compact each is allowed to be,
 * and what a missing column costs. Three surfaces, three different promises:
 *
 * - **A conversation turn carries a compact summary** — the recognized facts of the thing it
 *   reports, capped, and absent entirely when nothing was recognized (a snapshot re-sent
 *   every five seconds does not say "no facts" 360 times).
 * - **`GET /api/task/:id` carries the whole of it** — every fact from both sources merged
 *   with provenance, beside the complete raw evidence (the full result body it already had,
 *   and now the raw payload of every worker completion that named the task).
 * - **A missing column costs exactly the receipts that column held, by name** (`meta.
 *   degraded`) — and an ordinary unknown shape costs nothing at all, because unknown shapes
 *   are normal here, not schema drift.
 */

const AT = new Date('2026-07-08T12:00:00Z');
const COORDINATOR = handleFor('coordinator');
const WORKER = handleFor('worker');

function at(minutes: number): Date {
  return new Date(AT.getTime() + minutes * 60_000);
}

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/**
 * One completed task, reported twice — the two evidence sources the schema has. The result
 * says the branch; the worker's payload says the files and the report. Both are real shapes,
 * verbatim from the live database.
 */
function completedFixture(): FixtureBuilder {
  return new FixtureBuilder()
    .task({
      id: 'task_done',
      handle: COORDINATOR,
      title: 'Ship the receipts',
      spec: 'Implement the thing.',
      status: 'completed',
      result: '{"branch":"nvergez/94-codex","head":"b41fb92"}',
      createdAt: AT,
      completedAt: at(40),
    })
    .dispatch({
      id: 'ctx_done',
      taskId: 'task_done',
      assigneeHandle: WORKER,
      status: 'completed',
      dispatchedAt: at(1),
      completedAt: at(39),
    })
    .message({
      type: 'worker_done',
      fromHandle: WORKER,
      toHandle: COORDINATOR,
      subject: 'Done: Ship the receipts',
      body: 'Three sentences about what happened.',
      payload: {
        taskId: 'task_done',
        dispatchId: 'ctx_done',
        filesModified: ['src/shared/receipt.ts', 'test/server/receipt.test.ts'],
        reportPath: 'docs/report.md',
      },
      createdAt: at(38),
    });
}

async function turnsOf(builder: FixtureBuilder): Promise<Turn[]> {
  harness = await serve(builder.write(tempDbPath()));
  return (await harness.snapshot()).snapshot.turns;
}

describe('the conversation carries a compact receipt', () => {
  it('summarizes a result turn from the full column, not from the 240-character preview', async () => {
    const turns = await turnsOf(completedFixture());
    const result = turns.find((turn) => turn.kind === 'result')!;

    expect(result.receipt).toEqual([
      { kind: 'branch', value: 'nvergez/94-codex', sources: ['tasks.result · branch'] },
    ]);
  });

  it('summarizes a worker_done turn from its payload', async () => {
    const turns = await turnsOf(completedFixture());
    const done = turns.find((turn) => turn.kind === 'worker_done')!;

    expect(done.receipt).toEqual([
      { kind: 'report', value: 'docs/report.md', sources: ['worker_done.payload · reportPath'] },
      { kind: 'file', value: 'src/shared/receipt.ts', sources: ['worker_done.payload · filesModified'] },
      { kind: 'file', value: 'test/server/receipt.test.ts', sources: ['worker_done.payload · filesModified'] },
    ]);
  });

  it('says nothing at all when nothing was recognized — absent, not empty', async () => {
    const turns = await turnsOf(
      new FixtureBuilder()
        .task({
          id: 'task_prose',
          handle: COORDINATOR,
          status: 'completed',
          result: 'Done: three sentences of prose.',
          createdAt: AT,
          completedAt: at(10),
        })
        .message({
          type: 'status',
          fromHandle: WORKER,
          toHandle: COORDINATOR,
          subject: 'thinking',
          body: 'still going',
          payload: { taskId: 'task_prose' },
          createdAt: at(5),
        })
    );

    // A prose result recognizes nothing; a status message is not a completion at all. On a
    // snapshot re-sent whole every five seconds, the default is absence (SPEC §6.3).
    for (const turn of turns) {
      expect(turn).not.toHaveProperty('receipt');
      expect(turn).not.toHaveProperty('receiptOmitted');
    }
  });

  it('caps the compact summary and says how much the inspector still holds', async () => {
    const files = Array.from({ length: 30 }, (_, n) => `src/generated/file-${n}.ts`);
    const turns = await turnsOf(
      new FixtureBuilder().task({
        id: 'task_wide',
        handle: COORDINATOR,
        status: 'completed',
        // Far past BODY_PREVIEW_CHARS, so a summary read from the preview would parse to
        // nothing — the cap below is also the proof the *full* column was read.
        result: JSON.stringify({ filesModified: files }),
        createdAt: AT,
        completedAt: at(10),
      })
    );

    const result = turns.find((turn) => turn.kind === 'result')!;

    expect(result.receipt).toHaveLength(8);
    expect(result.receiptOmitted).toBe(22);
    // …while the body itself stays the honest preview it always was.
    expect(result.body.length).toBeLessThanOrEqual(240);
    expect(result.truncated).toBe(true);
  });
});

async function detailOf(builder: FixtureBuilder, id: string): Promise<TaskDetail> {
  harness = await serve(builder.write(tempDbPath()));
  const response = await harness.task(id);
  expect(response.status).toBe(200);
  return (await response.json()) as TaskDetail;
}

describe('the inspector detail carries the whole receipt, and the raw evidence beside it', () => {
  it('merges both sources with provenance, deduplicating agreement and keeping conflict', async () => {
    const builder = new FixtureBuilder()
      .task({
        id: 'task_two_sources',
        handle: COORDINATOR,
        status: 'completed',
        // The result and the payload agree on one file and disagree on the branch.
        result: '{"branch":"nvergez/94-codex","filesModified":["src/a.ts"]}',
        createdAt: AT,
        completedAt: at(40),
      })
      .message({
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done',
        payload: { taskId: 'task_two_sources', branch: 'nvergez/94-claude', filesModified: ['src/a.ts'] },
        createdAt: at(38),
      });

    const detail = await detailOf(builder, 'task_two_sources');

    expect(detail.receipt).toEqual([
      // The conflict: two facts, both visible, each naming its side (#67).
      { kind: 'branch', value: 'nvergez/94-codex', sources: ['tasks.result · branch'] },
      { kind: 'branch', value: 'nvergez/94-claude', sources: ['worker_done.payload · branch'] },
      // The agreement: one fact, wearing both provenances.
      {
        kind: 'file',
        value: 'src/a.ts',
        sources: ['tasks.result · filesModified', 'worker_done.payload · filesModified'],
      },
    ]);
  });

  it('keeps every completion payload verbatim — recognized, unknown and malformed alike', async () => {
    const builder = new FixtureBuilder()
      .task({ id: 'task_raw', handle: COORDINATOR, status: 'completed', createdAt: AT, completedAt: at(40) })
      .message({
        id: 'msg_known',
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done',
        payload: { taskId: 'task_raw', reportPath: 'docs/report.md' },
        createdAt: at(20),
      })
      .message({
        id: 'msg_strange',
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done again, strangely',
        // A shape this build has never seen. It must survive to the screen exactly as
        // written — schema tolerance applies to outcomes too (#67).
        payload: { taskId: 'task_raw', outcome: { nested: ['x'] }, score: 0.9 },
        createdAt: at(30),
      })
      .message({
        id: 'msg_other_task',
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done: somebody else',
        payload: { taskId: 'task_elsewhere', reportPath: 'not/this/tasks.md' },
        createdAt: at(35),
      });

    const detail = await detailOf(builder, 'task_raw');

    // The payload is the column's text, byte for byte — never a parse re-serialized to look
    // like it, which would silently collapse a duplicated key or reformat a number (#67).
    expect(detail.completions).toEqual([
      {
        messageId: 'msg_known',
        at: at(20).toISOString(),
        payload: '{"taskId":"task_raw","reportPath":"docs/report.md"}',
      },
      {
        messageId: 'msg_strange',
        at: at(30).toISOString(),
        payload: '{"taskId":"task_raw","outcome":{"nested":["x"]},"score":0.9}',
      },
    ]);

    // The unknown shape contributed nothing to the facts — and cost nothing else.
    expect(detail.receipt).toEqual([
      { kind: 'report', value: 'docs/report.md', sources: ['worker_done.payload · reportPath'] },
    ]);
  });

  it('passes an unparseable payload and result through as the strings they are', async () => {
    const dbPath = new FixtureBuilder()
      .task({
        id: 'task_broken',
        handle: COORDINATOR,
        status: 'completed',
        result: '{"this is not json',
        createdAt: AT,
        completedAt: at(40),
      })
      .message({
        id: 'msg_broken',
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done',
        payload: { taskId: 'task_broken' },
        createdAt: at(20),
      })
      .write(tempDbPath());
    // The builder always writes valid JSON, so a corrupt payload has to be forged — the
    // column is TEXT and nothing anywhere stops Orca, or anyone, writing this into it.
    corruptPayload(dbPath, 'msg_broken', '{"taskId":"task_broken", "files": [');
    harness = await serve(dbPath);

    const response = await harness.task('task_broken');
    expect(response.status).toBe(200);
    const detail = (await response.json()) as TaskDetail;

    // Neither source parses; neither is recognized; neither disappears. The raw strings are
    // the whole story, verbatim (#67).
    expect(detail.receipt).toEqual([]);
    expect(detail.result).toBe('{"this is not json');
    // An unparseable payload names no task, so it cannot honestly be attributed to this one —
    // it stays in the message feed, unattached, rather than being guessed into a completion.
    expect(detail.completions).toEqual([]);
  });

  it('keeps what JSON itself would quietly lose — a key one document states twice', async () => {
    const dbPath = new FixtureBuilder()
      .task({ id: 'task_twice', handle: COORDINATOR, status: 'completed', createdAt: AT, completedAt: at(40) })
      .message({
        id: 'msg_twice',
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done',
        payload: { taskId: 'task_twice' },
        createdAt: at(20),
      })
      .write(tempDbPath());
    // Legal JSON, hostile shape: `JSON.parse` keeps only the last `branch`. A parse-then-
    // stringify rendering would erase the first one before any reader ran.
    corruptPayload(dbPath, 'msg_twice', '{"taskId":"task_twice","branch":"nvergez/a","branch":"nvergez/b"}');
    harness = await serve(dbPath);

    const detail = (await (await harness.task('task_twice')).json()) as TaskDetail;

    // The recognized fact is honest about what parsing sees (last wins)…
    expect(detail.receipt).toEqual([
      { kind: 'branch', value: 'nvergez/b', sources: ['worker_done.payload · branch'] },
    ]);
    // …and the verbatim payload still shows both, because it is the column's text itself.
    expect(detail.completions[0]!.payload).toBe('{"taskId":"task_twice","branch":"nvergez/a","branch":"nvergez/b"}');
  });
});

/** The fixture builder always writes valid JSON, so a corrupt column has to be forged. */
function corruptPayload(dbPath: string, messageId: string, payload: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('UPDATE messages SET payload = ? WHERE id = ?').run(payload, messageId);
  } finally {
    db.close();
  }
}

describe('a missing column costs exactly the receipts it held, by name', () => {
  it('loses result receipts without tasks.result — worker completions, messages and the DAG stay', async () => {
    const builder = new FixtureBuilder({ omitColumns: { tasks: ['result'] } })
      .task({ id: 'task_done', handle: COORDINATOR, status: 'completed', createdAt: AT, completedAt: at(40) })
      .message({
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done',
        body: 'Summary.',
        payload: { taskId: 'task_done', reportPath: 'docs/report.md' },
        createdAt: at(38),
      });
    harness = await serve(builder.write(tempDbPath()));

    // Replayed from the start of the cursor, because a *first* connect misses nothing and so
    // carries no delta (#69) — and the claim below is about the messages still flowing.
    const event = await harness.snapshot(0);

    // Named, for a human, in meta.degraded (SPEC §12.4) — receipt enhancement, not just the
    // result body the older entry already covers.
    expect(event.meta.degraded.some((entry) => entry.includes('Outcome receipts from task results'))).toBe(true);

    // …and the cost stops there: the DAG renders, the messages flow, and the worker's own
    // receipt is still read out of its payload.
    expect(event.snapshot.tasks).toHaveLength(1);
    expect(event.messages.some((message) => message.type === 'worker_done')).toBe(true);
    const done = event.snapshot.turns.find((turn) => turn.kind === 'worker_done')!;
    expect(done.receipt).toEqual([
      { kind: 'report', value: 'docs/report.md', sources: ['worker_done.payload · reportPath'] },
    ]);

    const detail = (await (await harness.task('task_done')).json()) as TaskDetail;
    expect(detail.receipt).toEqual([
      { kind: 'report', value: 'docs/report.md', sources: ['worker_done.payload · reportPath'] },
    ]);
  });

  it('loses completion receipts without messages.payload — result receipts stay', async () => {
    const builder = new FixtureBuilder({ omitColumns: { messages: ['payload'] } })
      .task({
        id: 'task_done',
        handle: COORDINATOR,
        status: 'completed',
        result: '{"branch":"nvergez/67"}',
        createdAt: AT,
        completedAt: at(40),
      })
      .message({
        type: 'worker_done',
        fromHandle: WORKER,
        toHandle: COORDINATOR,
        subject: 'Done',
        payload: { taskId: 'task_done', reportPath: 'docs/report.md' },
        createdAt: at(38),
      });
    harness = await serve(builder.write(tempDbPath()));

    const event = await harness.snapshot();
    expect(event.meta.degraded.some((entry) => entry.includes('Outcome receipts from worker completions'))).toBe(
      true
    );

    const detail = (await (await harness.task('task_done')).json()) as TaskDetail;
    expect(detail.completions).toEqual([]);
    expect(detail.receipt).toEqual([{ kind: 'branch', value: 'nvergez/67', sources: ['tasks.result · branch'] }]);
  });

  it('does not call an ordinary unknown shape degradation', async () => {
    harness = await serve(
      new FixtureBuilder()
        .task({
          id: 'task_odd',
          handle: COORDINATOR,
          status: 'completed',
          result: '{"shape": {"nobody": "has seen"}}',
          createdAt: AT,
          completedAt: at(40),
        })
        .write(tempDbPath())
    );

    // Unknown receipt shapes are ordinary retained evidence, not schema drift (SPEC §12.4).
    expect((await harness.snapshot()).meta.degraded).toEqual([]);
  });
});

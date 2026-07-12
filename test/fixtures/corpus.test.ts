import type { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { liveShapeCorpus } from './corpus.ts';
import { closeFixtures, count as countIn, openFixture, rows as rowsIn } from './read.ts';

/**
 * The corpus reproduces the live database's shape, so "it works on the real thing" is a
 * property the suite checks rather than hopes (#13). Every number asserted here comes
 * from the live database as reported in #12/#13 — not from the corpus code.
 */

let db: DatabaseSync;

beforeAll(() => {
  db = openFixture(liveShapeCorpus());
});

afterAll(closeFixtures);

const count = (sql: string) => countIn(db, sql);
const rows = <T = Record<string, unknown>>(sql: string) => rowsIn<T>(db, sql);

describe('the live-shape corpus', () => {
  it('holds ~76 tasks, 4 of them with no terminal handle', () => {
    expect(count('SELECT COUNT(*) AS n FROM tasks')).toBe(76);
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE created_by_terminal_handle IS NULL')).toBe(4);
  });

  it('groups into 13 runs: 12 handles plus the one unattributed bucket', () => {
    // Run inference buckets by handle, and the null-handle tasks collect into one
    // synthetic run rather than vanishing (SPEC §4.3). That is 13 buckets, and no handle
    // bucket splits, because no run has an internal gap over 6h.
    const buckets = rows<{ handle: string | null; n: number }>(
      `SELECT created_by_terminal_handle AS handle, COUNT(*) AS n FROM tasks GROUP BY created_by_terminal_handle`
    );

    expect(buckets).toHaveLength(13);
    expect(buckets.filter((bucket) => bucket.handle === null)).toEqual([{ handle: null, n: 4 }]);
  });

  it('leaves 4 of those 13 runs entirely edgeless', () => {
    const bucketsWithEdges = new Set(
      rows<{ handle: string | null }>(
        `SELECT DISTINCT created_by_terminal_handle AS handle FROM tasks WHERE deps != '[]'`
      ).map((row) => row.handle)
    );

    expect(13 - bucketsWithEdges.size).toBe(4);
    // The unattributed bucket is one of the four: none of its tasks has a dependency.
    expect(bucketsWithEdges.has(null)).toBe(false);
  });

  it('leaves ~50 tasks as isolated singletons — no deps in, no deps out', () => {
    const all = rows<{ id: string; deps: string }>('SELECT id, deps FROM tasks');
    const depended = new Set(all.flatMap((task) => JSON.parse(task.deps) as string[]));
    const isolated = all.filter((task) => task.deps === '[]' && !depended.has(task.id));

    // ~50 of 76, which is why the canvas pulls them out of the layered layout and grid-packs them:
    // left in, they flatten the graph into a ~50-node-wide ribbon that `fitView` zooms out until
    // nothing is legible (SPEC §7.5).
    expect(isolated).toHaveLength(47);
  });

  it('has one terminal that was picked up again after more than six idle hours', () => {
    // **The shape the waves exist for** (SPEC §4.3). This gap used to cut the terminal's tasks into
    // two unrelated rows in the rail, silently. It is now one orchestrator, and the gap is drawn on
    // the canvas with its own length written on it — so a corpus with no such gap in it would let a
    // build that never drew a wave pass every test it has.
    const spans = rows<{ handle: string; created_at: string }>(
      `SELECT created_by_terminal_handle AS handle, created_at FROM tasks
       WHERE created_by_terminal_handle IS NOT NULL
       ORDER BY created_by_terminal_handle, created_at`
    );

    const gapsOf = (handle: string): number[] => {
      const times = spans
        .filter((row) => row.handle === handle)
        .map((row) => Date.parse(`${row.created_at.replace(' ', 'T')}Z`));
      return times.slice(1).map((time, i) => time - times[i]!);
    };

    const handles = [...new Set(spans.map((row) => row.handle))];
    const waved = handles.filter((handle) => gapsOf(handle).some((gap) => gap > 6 * 60 * 60 * 1000));

    expect(waved).toHaveLength(1);
    expect(Math.max(...gapsOf(waved[0]!))).toBeGreaterThan(13 * 60 * 60 * 1000);
  });

  it('has a dependency that crosses that gap — the work was picked up where it stopped', () => {
    // The canvas lays each wave out on its own and joins them with a long line. A build that dropped
    // the edge instead would call a real dependency a dead end.
    const tasks = rows<{ id: string; handle: string | null; deps: string; created_at: string }>(
      'SELECT id, created_by_terminal_handle AS handle, deps, created_at FROM tasks'
    );
    const at = (id: string): number => {
      const row = tasks.find((task) => task.id === id)!;
      return Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    };

    const crossing = tasks.filter((task) =>
      (JSON.parse(task.deps) as string[]).some((dep) => at(task.id) - at(dep) > 6 * 60 * 60 * 1000)
    );

    expect(crossing).toHaveLength(1);
  });

  it('spans 4 days, and holds one run overnight without a >6h gap between its tasks', () => {
    expect(rows(`SELECT DISTINCT date(created_at) AS day FROM tasks`).length).toBeGreaterThanOrEqual(4);

    // The 13-task run that runs 20:10 → 06:58. A short idle threshold would shred it;
    // the 6h rule holds it together (SPEC §4.3 step 3).
    const overnight = rows<{ created_at: string }>(
      `SELECT created_at FROM tasks
       WHERE created_by_terminal_handle = (
         SELECT created_by_terminal_handle FROM tasks
         GROUP BY created_by_terminal_handle HAVING COUNT(*) = 13
       )
       ORDER BY created_at`
    ).map((row) => Date.parse(`${row.created_at.replace(' ', 'T')}Z`));

    const gaps = overnight.slice(1).map((time, i) => time - overnight[i]!);
    expect(Math.max(...gaps)).toBeLessThan(6 * 60 * 60 * 1000);
    expect(overnight.at(-1)! - overnight[0]!).toBeGreaterThan(10 * 60 * 60 * 1000);
  });

  it('has two handles whose runs genuinely overlap in time', () => {
    // Which is why handle is the run key and time is only the tiebreaker: a time-first
    // clustering would merge these two unrelated orchestrations into one.
    const spans = rows<{ handle: string; from: string; to: string }>(
      `SELECT created_by_terminal_handle AS handle, MIN(created_at) AS "from", MAX(created_at) AS "to"
       FROM tasks WHERE created_by_terminal_handle IS NOT NULL
       GROUP BY created_by_terminal_handle`
    );

    const overlapping = spans.filter((a) =>
      spans.some((b) => b.handle !== a.handle && b.from < a.to && a.from < b.to)
    );

    expect(overlapping.length).toBeGreaterThanOrEqual(2);
  });

  it('holds 466 messages, 302 of them heartbeats', () => {
    expect(count('SELECT COUNT(*) AS n FROM messages')).toBe(466);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE type = 'heartbeat'`)).toBe(302);
    // Which leaves 164 rows for the feed the user actually reads.
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE type != 'heartbeat'`)).toBe(164);
  });

  it('holds 53 gate messages and zero decision_gates rows — the trap, reproduced', () => {
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE type = 'decision_gate'`)).toBe(53);
    expect(count('SELECT COUNT(*) AS n FROM decision_gates')).toBe(0);
    // 21 of the 53 name a task; the rest can only attach to a run.
    expect(
      count(`SELECT COUNT(*) AS n FROM messages
             WHERE type = 'decision_gate' AND json_extract(payload, '$.taskId') IS NOT NULL`)
    ).toBe(21);
    // 13 were never answered: no reply threads on the gate message's id.
    expect(
      count(`SELECT COUNT(*) AS n FROM messages g
             WHERE g.type = 'decision_gate'
               AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.thread_id = g.id)`)
    ).toBe(13);
  });

  it('writes gate messages in every shape the live database really holds', () => {
    // The trap inside the trap (#19). Two writers produce a `decision_gate` message and they
    // put the question in different places: `orchestration ask` writes {question, options}
    // (docs/research/db-history.md §2), while a worker escalating by hand with `orchestration
    // send --type decision_gate` writes {taskId, dispatchId} and puts the question in the
    // **subject**. Tallied on the live database — 58 gate messages — the payload shapes are
    // 25 {question,options}, 4 {question}, 22 {taskId,dispatchId}, 7 empty: so **half of them
    // carry no payload question at all**, and a reader that takes the question from the
    // payload alone renders a blank question over half the gates it shows.
    const shapes = rows<{ question: string | null; taskId: string | null }>(
      `SELECT json_extract(payload, '$.question') AS question, json_extract(payload, '$.taskId') AS taskId
       FROM messages WHERE type = 'decision_gate'`
    );

    // The `ask` gates: a question in the payload, and — for 6 of them — a task as well, which
    // is the shape SPEC §4.5 describes and the one the fixture must go on exercising.
    expect(shapes.filter((gate) => gate.question !== null && gate.taskId === null)).toHaveLength(32);
    expect(shapes.filter((gate) => gate.question !== null && gate.taskId !== null)).toHaveLength(6);

    // The hand-written gates: a task, no payload question, and the question in the subject —
    // where a payload-only reader will never look.
    expect(shapes.filter((gate) => gate.question === null && gate.taskId !== null)).toHaveLength(15);
    expect(
      count(`SELECT COUNT(*) AS n FROM messages
             WHERE type = 'decision_gate'
               AND json_extract(payload, '$.question') IS NULL
               AND subject LIKE 'Question %'`)
    ).toBe(15);
  });

  it('holds escalations — the loudest rows in the feed, and the ones it paints red', () => {
    // Few, and every one of them naming the task its worker got stuck on. Without them the
    // feed's default content would be three types, not the four the ruling names (SPEC §7.7).
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE type = 'escalation'`)).toBe(6);
    expect(
      count(`SELECT COUNT(*) AS n FROM messages
             WHERE type = 'escalation' AND json_extract(payload, '$.taskId') IS NOT NULL`)
    ).toBe(6);
  });

  it('leaves coordinator_runs empty, as it is in practice', () => {
    expect(count('SELECT COUNT(*) AS n FROM coordinator_runs')).toBe(0);
  });

  it('carries payload.taskId on ~83% of messages', () => {
    const withTaskId = count(
      `SELECT COUNT(*) AS n FROM messages WHERE json_extract(payload, '$.taskId') IS NOT NULL`
    );
    const share = withTaskId / count('SELECT COUNT(*) AS n FROM messages');

    expect(share).toBeGreaterThan(0.8);
    expect(share).toBeLessThan(0.86);
  });

  it('has messages whose payload.taskId points at a task that no longer exists', () => {
    const orphaned = count(
      `SELECT COUNT(*) AS n FROM messages m
       WHERE json_extract(m.payload, '$.taskId') IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = json_extract(m.payload, '$.taskId'))`
    );

    expect(orphaned).toBe(3);
  });

  it('records every dispatch attempt, so retries and the circuit breaker are visible', () => {
    expect(count('SELECT COUNT(DISTINCT task_id) AS n FROM dispatch_contexts')).toBe(66);
    expect(count('SELECT COUNT(*) AS n FROM dispatch_contexts')).toBe(71);

    const retried = rows(
      'SELECT task_id, COUNT(*) AS attempts FROM dispatch_contexts GROUP BY task_id HAVING attempts > 1'
    );
    expect(retried).toHaveLength(3);

    // Two tasks burned all three attempts and tripped the breaker (it trips at 3).
    expect(count(`SELECT COUNT(*) AS n FROM dispatch_contexts WHERE status = 'circuit_broken'`)).toBe(2);
    expect(count('SELECT MAX(failure_count) AS n FROM dispatch_contexts')).toBe(3);
  });

  it('carries the split timestamp formats in the columns where each really occurs', () => {
    const sqlFormat = `GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`;

    expect(count(`SELECT COUNT(*) AS n FROM tasks WHERE created_at NOT ${sqlFormat}`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM messages WHERE created_at NOT ${sqlFormat}`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM dispatch_contexts WHERE dispatched_at NOT ${sqlFormat}`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM dispatch_contexts WHERE last_heartbeat_at IS NOT NULL
                  AND last_heartbeat_at NOT ${sqlFormat}`)).toBe(0);

    // tasks.completed_at is the odd one out: written from JS, so ISO-8601.
    expect(
      count(`SELECT COUNT(*) AS n FROM tasks WHERE completed_at IS NOT NULL AND completed_at NOT LIKE '%T%Z'`)
    ).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM tasks WHERE completed_at IS NOT NULL')).toBe(57);

    // …and no task completed before it was created, once both are read as instants.
    for (const task of rows<{ created_at: string; completed_at: string }>(
      'SELECT created_at, completed_at FROM tasks WHERE completed_at IS NOT NULL'
    )) {
      expect(Date.parse(`${task.created_at.replace(' ', 'T')}Z`)).toBeLessThan(Date.parse(task.completed_at));
    }
  });

  it('covers every task status the DAG has to colour', () => {
    const byStatus = Object.fromEntries(
      rows<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').map((row) => [
        row.status,
        row.n,
      ])
    );

    expect(byStatus).toEqual({ completed: 57, dispatched: 7, pending: 6, ready: 4, failed: 2 });
  });

  it('is reproducible: the same corpus twice is the same database', () => {
    const again = openFixture(liveShapeCorpus());

    const digest = (handle: DatabaseSync) =>
      JSON.stringify([
        handle.prepare('SELECT * FROM tasks ORDER BY id').all(),
        handle.prepare('SELECT * FROM dispatch_contexts ORDER BY id').all(),
        handle.prepare('SELECT * FROM messages ORDER BY sequence').all(),
      ]);

    expect(digest(again)).toBe(digest(db));
  });
});

// PROTOTYPE — one-shot READ-ONLY dump of Orca's orchestration DB to snapshot.json.
// Never opens the DB writable. Usage: node snapshot.mjs [path-to-orchestration.db]
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dbPath = process.argv[2] ?? join(homedir(), '.config/orca/orchestration.db');
const db = new DatabaseSync(dbPath, { readOnly: true });

const trim = (s, n) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

const tasks = db
  .prepare(
    `SELECT id, parent_id, task_title, display_name, status, deps,
            created_by_terminal_handle, created_at, completed_at
     FROM tasks`
  )
  .all()
  .map((t) => ({ ...t, task_title: trim(t.task_title, 120), display_name: trim(t.display_name, 120) }));

const dispatchContexts = db
  .prepare(
    `SELECT id, task_id, assignee_handle, status, failure_count,
            dispatched_at, completed_at, last_heartbeat_at
     FROM dispatch_contexts`
  )
  .all();

const decisionGates = db
  .prepare(
    `SELECT id, task_id, question, options, status, resolution, created_at, resolved_at
     FROM decision_gates`
  )
  .all()
  .map((g) => ({ ...g, question: trim(g.question, 200) }));

const messages = db
  .prepare(
    `SELECT id, from_handle, to_handle, subject, type, priority, thread_id, sequence, created_at
     FROM messages ORDER BY sequence`
  )
  .all()
  .map((m) => ({ ...m, subject: trim(m.subject, 120) }));

db.close();

const snapshot = {
  capturedAt: new Date().toISOString(),
  dbPath,
  tasks,
  dispatchContexts,
  decisionGates,
  messages,
};

const out = join(dirname(fileURLToPath(import.meta.url)), 'snapshot.json');
writeFileSync(out, JSON.stringify(snapshot, null, 1));
console.log(
  `wrote ${out}: ${tasks.length} tasks, ${dispatchContexts.length} dispatch contexts, ` +
    `${decisionGates.length} gates, ${messages.length} messages`
);

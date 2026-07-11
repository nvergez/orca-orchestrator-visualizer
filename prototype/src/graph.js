// PROTOTYPE — turns snapshot.json into React Flow nodes/edges.
import snapshot from '../snapshot.json';

export const NODE_W = 240;
export const NODE_H = 84;

export const STATUS_COLORS = {
  pending: { bg: '#f4f4f5', border: '#a1a1aa', text: '#3f3f46' },
  ready: { bg: '#dbeafe', border: '#3b82f6', text: '#1e3a8a' },
  dispatched: { bg: '#fef3c7', border: '#f59e0b', text: '#78350f' },
  completed: { bg: '#dcfce7', border: '#22c55e', text: '#14532d' },
  failed: { bg: '#fee2e2', border: '#ef4444', text: '#7f1d1d' },
  blocked: { bg: '#f3e8ff', border: '#a855f7', text: '#581c87' },
};

export const meta = {
  capturedAt: snapshot.capturedAt,
  dbPath: snapshot.dbPath,
  counts: {
    tasks: snapshot.tasks.length,
    edges: snapshot.tasks.reduce((n, t) => n + JSON.parse(t.deps || '[]').length, 0),
    gates: snapshot.decisionGates.length,
    messages: snapshot.messages.length,
  },
};

const shortHandle = (h) => (h ? h.replace(/^term_/, '').slice(0, 8) : null);

// The real snapshot currently has zero parent_id rows and zero decision gates.
// The synthetic overlay injects a fake parent group + gated task so the visual
// treatment can still be judged. Everything synthetic is marked as such.
const SYNTHETIC_TASKS = [
  { id: 'syn_parent', title: 'SYNTHETIC parent task (decomposed)', status: 'dispatched', group: true },
  { id: 'syn_a', title: 'SYNTHETIC child A — schema reader', status: 'completed', parent: 'syn_parent', deps: [] },
  { id: 'syn_b', title: 'SYNTHETIC child B — layout spike', status: 'dispatched', parent: 'syn_parent', deps: ['syn_a'], assignee: 'term_deadbeefcafe' },
  { id: 'syn_c', title: 'SYNTHETIC child C — gated rollout', status: 'blocked', parent: 'syn_parent', deps: ['syn_b'], gate: 'pending' },
];

export function buildGraph({ synthetic }) {
  // latest dispatch context per task (real runs re-dispatch after failures)
  const dispatchByTask = new Map();
  for (const dc of snapshot.dispatchContexts) {
    const prev = dispatchByTask.get(dc.task_id);
    if (!prev || (dc.dispatched_at ?? 0) >= (prev.dispatched_at ?? 0)) dispatchByTask.set(dc.task_id, dc);
  }
  const gateByTask = new Map();
  for (const g of snapshot.decisionGates) {
    if (!gateByTask.has(g.task_id) || g.status === 'pending') gateByTask.set(g.task_id, g);
  }

  const nodes = [];
  const edges = [];

  for (const t of snapshot.tasks) {
    const dc = dispatchByTask.get(t.id);
    const gate = gateByTask.get(t.id);
    nodes.push({
      id: t.id,
      type: 'task',
      position: { x: 0, y: 0 },
      width: NODE_W,
      height: NODE_H,
      parentId: t.parent_id ?? undefined,
      data: {
        title: t.display_name || t.task_title || t.id,
        status: t.status,
        assignee: shortHandle(dc?.assignee_handle),
        dispatchStatus: dc?.status,
        failureCount: dc?.failure_count ?? 0,
        gate: gate?.status,
      },
    });
    for (const dep of JSON.parse(t.deps || '[]')) {
      edges.push({
        id: `${dep}->${t.id}`,
        source: dep,
        target: t.id,
        animated: t.status === 'dispatched',
        markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
        style: { strokeWidth: 1.5 },
      });
    }
  }

  if (synthetic) {
    for (const s of SYNTHETIC_TASKS) {
      if (s.group) {
        nodes.push({
          id: s.id,
          type: 'taskGroup',
          position: { x: 0, y: 0 },
          data: { title: s.title, status: s.status },
        });
        continue;
      }
      nodes.push({
        id: s.id,
        type: 'task',
        position: { x: 0, y: 0 },
        width: NODE_W,
        height: NODE_H,
        parentId: s.parent,
        data: {
          title: s.title,
          status: s.status,
          assignee: shortHandle(s.assignee),
          gate: s.gate,
          synthetic: true,
        },
      });
      for (const dep of s.deps) {
        edges.push({
          id: `${dep}->${s.id}`,
          source: dep,
          target: s.id,
          animated: s.status === 'dispatched',
          markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
          style: { strokeWidth: 1.5 },
        });
      }
    }
    // tie the synthetic cluster into the real graph so it doesn't float alone
    const someCompleted = snapshot.tasks.find((t) => t.status === 'completed');
    if (someCompleted) {
      edges.push({
        id: `${someCompleted.id}->syn_parent`,
        source: someCompleted.id,
        target: 'syn_parent',
        markerEnd: { type: 'arrowclosed', width: 18, height: 18 },
        style: { strokeWidth: 1.5, strokeDasharray: '4 3' },
      });
    }
  }

  return { nodes, edges };
}

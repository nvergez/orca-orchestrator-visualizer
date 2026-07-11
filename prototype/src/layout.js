// PROTOTYPE — auto-layout: dagre vs elkjs, with optional grid-packing of
// isolated nodes (the real snapshot is mostly disconnected singletons).
import dagre from '@dagrejs/dagre';
import ELK from 'elkjs/lib/elk.bundled.js';
import { NODE_W, NODE_H } from './graph.js';

const elk = new ELK();

const GROUP_PAD = 44;
const GROUP_GAP = 24;

// Children of a group are laid out in a simple row INSIDE the group; the group
// itself goes through the layout engine as one big node. (elk could do true
// compound layout — noted in the README — but this keeps both engines equal.)
function absorbGroups(nodes) {
  const groups = nodes.filter((n) => n.type === 'taskGroup');
  const byParent = new Map();
  for (const n of nodes) {
    if (n.parentId) {
      if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
      byParent.get(n.parentId).push(n);
    }
  }
  for (const g of groups) {
    const kids = byParent.get(g.id) ?? [];
    g.width = GROUP_PAD * 2 + Math.max(1, kids.length) * NODE_W + (kids.length - 1) * GROUP_GAP;
    g.height = GROUP_PAD * 2 + NODE_H + 20;
    g.style = { width: g.width, height: g.height };
    kids.forEach((k, i) => {
      k.position = { x: GROUP_PAD + i * (NODE_W + GROUP_GAP), y: GROUP_PAD + 20 };
    });
  }
  const topLevel = nodes.filter((n) => !n.parentId);
  const children = nodes.filter((n) => n.parentId);
  return { topLevel, children };
}

// Edges whose endpoint sits inside a group are re-routed to the group for the
// engine pass (React Flow still draws them to the child).
function liftEdges(edges, nodes) {
  const parentOf = new Map(nodes.filter((n) => n.parentId).map((n) => [n.id, n.parentId]));
  const seen = new Set();
  const lifted = [];
  for (const e of edges) {
    const s = parentOf.get(e.source) ?? e.source;
    const t = parentOf.get(e.target) ?? e.target;
    if (s === t) continue;
    const key = `${s}->${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lifted.push({ id: key, source: s, target: t });
  }
  return lifted;
}

function splitIsolated(topLevel, liftedEdges, packIsolated) {
  if (!packIsolated) return { connected: topLevel, isolated: [] };
  const touched = new Set();
  for (const e of liftedEdges) {
    touched.add(e.source);
    touched.add(e.target);
  }
  const connected = topLevel.filter((n) => touched.has(n.id));
  const isolated = topLevel.filter((n) => !touched.has(n.id));
  return { connected, isolated };
}

function packGrid(isolated, bounds, dir) {
  const GAP = 24;
  const startY = bounds.maxY + 120;
  const cols = Math.max(4, Math.ceil(Math.sqrt(isolated.length * 2)));
  isolated.forEach((n, i) => {
    n.position = {
      x: bounds.minX + (i % cols) * (NODE_W + GAP),
      y: startY + Math.floor(i / cols) * (NODE_H + GAP),
    };
  });
}

function boundsOf(nodes) {
  if (!nodes.length) return { minX: 0, maxY: 0 };
  return {
    minX: Math.min(...nodes.map((n) => n.position.x)),
    maxY: Math.max(...nodes.map((n) => n.position.y + (n.height ?? NODE_H))),
  };
}

export async function layout(nodes, edges, { engine, dir, packIsolated }) {
  // clone so React Flow sees fresh objects
  nodes = nodes.map((n) => ({ ...n, position: { ...n.position } }));
  const { topLevel, children } = absorbGroups(nodes);
  const lifted = liftEdges(edges, nodes);
  const { connected, isolated } = splitIsolated(topLevel, lifted, packIsolated);

  if (engine === 'dagre') {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: dir, nodesep: 30, ranksep: 70, marginx: 20, marginy: 20 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of connected) g.setNode(n.id, { width: n.width ?? NODE_W, height: n.height ?? NODE_H });
    for (const e of lifted) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
    dagre.layout(g);
    for (const n of connected) {
      const p = g.node(n.id);
      n.position = { x: p.x - (n.width ?? NODE_W) / 2, y: p.y - (n.height ?? NODE_H) / 2 };
    }
  } else {
    const idSet = new Set(connected.map((n) => n.id));
    const graph = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': dir === 'TB' ? 'DOWN' : 'RIGHT',
        'elk.layered.spacing.nodeNodeBetweenLayers': '70',
        'elk.spacing.nodeNode': '30',
        'elk.separateConnectedComponents': 'true',
        'elk.spacing.componentComponent': '60',
      },
      children: connected.map((n) => ({ id: n.id, width: n.width ?? NODE_W, height: n.height ?? NODE_H })),
      edges: lifted
        .filter((e) => idSet.has(e.source) && idSet.has(e.target))
        .map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    };
    const res = await elk.layout(graph);
    const pos = new Map(res.children.map((c) => [c.id, c]));
    for (const n of connected) {
      const p = pos.get(n.id);
      n.position = { x: p.x, y: p.y };
    }
  }

  if (isolated.length) packGrid(isolated, boundsOf(connected), dir);

  return [...connected, ...isolated, ...children];
}

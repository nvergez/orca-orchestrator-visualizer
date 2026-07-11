// PROTOTYPE — Orca orchestration DAG rendered with React Flow.
// Two layout variants switchable via ?variant= (dagre | elk) + floating bottom bar.
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Panel } from '@xyflow/react';
import { buildGraph, meta, STATUS_COLORS } from './graph.js';
import { layout } from './layout.js';
import { TaskNode, TaskGroupNode } from './TaskNode.jsx';

const VARIANTS = ['dagre', 'elk'];
const nodeTypes = { task: TaskNode, taskGroup: TaskGroupNode };

function useSearchParam(key, fallback) {
  const [val, setVal] = useState(() => new URLSearchParams(location.search).get(key) ?? fallback);
  const set = useCallback(
    (v) => {
      const p = new URLSearchParams(location.search);
      p.set(key, v);
      history.replaceState(null, '', `?${p}`);
      setVal(v);
    },
    [key]
  );
  return [val, set];
}

export default function App() {
  const params = new URLSearchParams(location.search);
  const [variant, setVariant] = useSearchParam('variant', 'dagre');
  const [dir, setDir] = useState(params.get('dir') === 'LR' ? 'LR' : 'TB');
  const [packIsolated, setPackIsolated] = useState(params.get('pack') !== '0');
  const [synthetic, setSynthetic] = useState(params.get('synthetic') === '1');
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [layoutMs, setLayoutMs] = useState(null);

  const engine = VARIANTS.includes(variant) ? variant : 'dagre';

  const graph = useMemo(() => buildGraph({ synthetic }), [synthetic]);

  useEffect(() => {
    let cancelled = false;
    const t0 = performance.now();
    const withDir = graph.nodes.map((n) => ({ ...n, data: { ...n.data, dir } }));
    layout(withDir, graph.edges, { engine, dir, packIsolated }).then((laid) => {
      if (cancelled) return;
      setNodes(laid);
      setEdges(graph.edges);
      setLayoutMs(Math.round(performance.now() - t0));
    });
    return () => {
      cancelled = true;
    };
  }, [graph, engine, dir, packIsolated]);

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      const i = VARIANTS.indexOf(engine);
      if (e.key === 'ArrowLeft') setVariant(VARIANTS[(i - 1 + VARIANTS.length) % VARIANTS.length]);
      if (e.key === 'ArrowRight') setVariant(VARIANTS[(i + 1) % VARIANTS.length]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [engine, setVariant]);

  const statusCounts = useMemo(() => {
    const c = {};
    for (const n of graph.nodes) if (n.type === 'task') c[n.data.status] = (c[n.data.status] ?? 0) + 1;
    return c;
  }, [graph]);

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        key={`${engine}-${dir}-${packIsolated}-${synthetic}`}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.05}
        nodesDraggable
        nodesConnectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
        <MiniMap pannable zoomable nodeColor={(n) => STATUS_COLORS[n.data?.status]?.border ?? '#ccc'} />

        <Panel position="top-left">
          <div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: '8px 12px', fontSize: 12, boxShadow: '0 1px 4px rgba(0,0,0,.1)' }}>
            <div style={{ fontWeight: 700, marginBottom: 4 }}>
              PROTOTYPE — Orca orchestration DAG
            </div>
            <div style={{ color: '#555' }}>
              snapshot {new Date(meta.capturedAt).toLocaleString()} · {meta.counts.tasks} tasks · {meta.counts.edges} dep edges · {meta.counts.gates} gates
            </div>
            <div style={{ color: '#555' }}>layout: <b>{engine}</b> ({layoutMs}ms)</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
              {Object.entries(STATUS_COLORS).map(([s, c]) => (
                <span key={s} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 3, background: c.border }} />
                  {s} {statusCounts[s] ? `(${statusCounts[s]})` : ''}
                </span>
              ))}
            </div>
          </div>
        </Panel>

        <Panel position="top-right">
          <div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: '8px 12px', fontSize: 12, display: 'flex', flexDirection: 'column', gap: 4, boxShadow: '0 1px 4px rgba(0,0,0,.1)' }}>
            <label>
              <input type="checkbox" checked={dir === 'LR'} onChange={(e) => setDir(e.target.checked ? 'LR' : 'TB')} /> left-to-right
            </label>
            <label>
              <input type="checkbox" checked={packIsolated} onChange={(e) => setPackIsolated(e.target.checked)} /> grid-pack isolated tasks
            </label>
            <label>
              <input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} /> synthetic hierarchy + gate demo
            </label>
          </div>
        </Panel>
      </ReactFlow>

      {/* floating variant switcher */}
      <div
        style={{
          position: 'fixed',
          bottom: 16,
          left: '50%',
          transform: 'translateX(-50%)',
          background: '#111827',
          color: '#f9fafb',
          borderRadius: 999,
          padding: '8px 16px',
          display: 'flex',
          gap: 14,
          alignItems: 'center',
          fontSize: 13,
          boxShadow: '0 4px 12px rgba(0,0,0,.35)',
          zIndex: 10,
        }}
      >
        <button style={btn} onClick={() => setVariant(VARIANTS[(VARIANTS.indexOf(engine) - 1 + VARIANTS.length) % VARIANTS.length])}>←</button>
        <span>
          <b>{engine}</b> — {engine === 'dagre' ? '@dagrejs/dagre layered' : 'elkjs layered + component packing'}
        </span>
        <button style={btn} onClick={() => setVariant(VARIANTS[(VARIANTS.indexOf(engine) + 1) % VARIANTS.length])}>→</button>
      </div>
    </div>
  );
}

const btn = {
  background: '#374151',
  color: '#f9fafb',
  border: 'none',
  borderRadius: 999,
  width: 28,
  height: 28,
  cursor: 'pointer',
  fontSize: 14,
};

// PROTOTYPE — custom React Flow nodes for tasks and (synthetic) parent groups.
import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { STATUS_COLORS, NODE_W, NODE_H } from './graph.js';

export function TaskNode({ data }) {
  const c = STATUS_COLORS[data.status] ?? STATUS_COLORS.pending;
  const dir = data.dir ?? 'TB';
  return (
    <div
      title={data.title}
      style={{
        width: NODE_W,
        height: NODE_H,
        boxSizing: 'border-box',
        background: c.bg,
        border: `1.5px solid ${c.border}`,
        borderLeft: `5px solid ${c.border}`,
        borderRadius: 6,
        padding: '5px 8px',
        fontSize: 11,
        color: c.text,
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        opacity: data.synthetic ? 0.85 : 1,
        outline: data.synthetic ? '2px dashed #94a3b8' : 'none',
      }}
    >
      <Handle type="target" position={dir === 'TB' ? Position.Top : Position.Left} style={{ opacity: 0.4 }} />
      <div style={{ display: 'flex', gap: 5, alignItems: 'center', fontSize: 10 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: c.border, flexShrink: 0 }} />
        <b>{data.status}</b>
        {data.failureCount > 0 && <span style={{ color: '#b91c1c' }}>✗{data.failureCount}</span>}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {data.gate && (
            <span
              style={{
                background: data.gate === 'pending' ? '#f97316' : '#64748b',
                color: '#fff',
                borderRadius: 4,
                padding: '1px 5px',
                fontWeight: 700,
              }}
            >
              ⛔ gate
            </span>
          )}
          {data.assignee && (
            <span
              style={{
                background: '#1e293b',
                color: '#e2e8f0',
                borderRadius: 4,
                padding: '1px 5px',
                fontFamily: 'ui-monospace, monospace',
              }}
            >
              {data.assignee}
            </span>
          )}
        </span>
      </div>
      <div
        style={{
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 3,
          WebkitBoxOrient: 'vertical',
          lineHeight: 1.25,
        }}
      >
        {data.title}
      </div>
      <Handle type="source" position={dir === 'TB' ? Position.Bottom : Position.Right} style={{ opacity: 0.4 }} />
    </div>
  );
}

export function TaskGroupNode({ data }) {
  const dir = data.dir ?? 'TB';
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        border: '2px dashed #64748b',
        borderRadius: 10,
        background: 'rgba(100,116,139,0.08)',
        fontSize: 11,
        color: '#334155',
      }}
    >
      <Handle type="target" position={dir === 'TB' ? Position.Top : Position.Left} style={{ opacity: 0.4 }} />
      <div style={{ padding: '6px 10px', fontWeight: 700 }}>▣ {data.title} — {data.status}</div>
      <Handle type="source" position={dir === 'TB' ? Position.Bottom : Position.Right} style={{ opacity: 0.4 }} />
    </div>
  );
}

// src/components/StatusPill.tsx
import React from 'react';

type Status = 'active' | 'processing' | 'completed' | 'error' | string;

const config: Record<string, { bg: string; color: string; label: string; dot: string }> = {
  active:     { bg: 'var(--wash-active)',  color: 'var(--status-active)',  dot: 'var(--status-active)',  label: 'Live' },
  processing: { bg: 'var(--wash-process)', color: 'var(--status-process)', dot: 'var(--status-process)', label: 'Processing' },
  completed:  { bg: 'var(--wash-active)',  color: 'var(--status-active)',  dot: 'var(--status-active)',  label: 'Completed' },
  error:      { bg: 'var(--wash-error)',   color: 'var(--status-error)',   dot: 'var(--status-error)',   label: 'Error' },
};

export function StatusPill({ status }: { status: Status }) {
  const c = config[status] ?? {
    bg: 'var(--wash-idle)', color: 'var(--status-idle)', dot: 'var(--status-idle)', label: status,
  };
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: '5px',
      padding: '2px 9px',
      borderRadius: '99px',
      background: c.bg,
      color: c.color,
      fontSize: '11.5px',
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}>
      <span style={{
        width: '5px', height: '5px', borderRadius: '50%',
        background: c.dot, flexShrink: 0,
        boxShadow: status === 'active' ? `0 0 4px ${c.dot}` : 'none',
      }} />
      {c.label}
    </span>
  );
}

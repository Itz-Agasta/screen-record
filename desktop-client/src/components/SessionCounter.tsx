/**
 * src/components/SessionCounter.tsx
 * ===================================
 * Displays the user's session usage as a compact pill + capacity bar.
 * Colour shifts from cyan → amber → red as capacity fills.
 */

import React from 'react';
import { useStore, selectSessionsRemaining } from '../lib/store';

export function SessionCounter() {
  const permitted  = useStore((s) => s.permittedSessions);
  const used       = useStore((s) => s.usedSessions);
  const remaining  = useStore(selectSessionsRemaining);

  if (permitted === 0) {
    return (
      <div style={wrapStyle}>
        <span style={{ color: 'var(--status-error)', fontSize: '10.5px' }}>
          No sessions allocated
        </span>
      </div>
    );
  }

  const pct = used / permitted;
  const fillColor =
    pct >= 1    ? 'var(--status-error)' :
    pct >= 0.75 ? 'var(--status-warn)'  :
                  'var(--accent)';

  return (
    <div style={wrapStyle}>
      {/* ── Text row ────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '9.5px', letterSpacing: '0.07em', fontWeight: 500 }}>
          SESSIONS
        </span>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: fillColor }}>
          {used}
          <span style={{ color: 'var(--text-muted)', margin: '0 2px' }}>/</span>
          {permitted}
        </span>
      </div>

      {/* ── Capacity bar ────────────────────────────────────────────── */}
      <div style={{
        height: '3px',
        background: 'var(--bg-elevated)',
        borderRadius: '2px',
        overflow: 'hidden',
        marginTop: '5px',
      }}>
        <div style={{
          height: '100%',
          width: `${Math.min(100, pct * 100)}%`,
          background: fillColor,
          borderRadius: '2px',
          transition: 'width 0.4s ease, background-color 0.4s ease',
        }} />
      </div>

      {/* ── Remaining label ─────────────────────────────────────────── */}
      <div style={{ textAlign: 'right', marginTop: '3px' }}>
        <span style={{ color: 'var(--text-muted)', fontSize: '9px' }}>
          {remaining} remaining
        </span>
      </div>
    </div>
  );
}

const wrapStyle: React.CSSProperties = {
  padding: '8px 11px',
  background: 'var(--bg-elevated)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--bg-border)',
};

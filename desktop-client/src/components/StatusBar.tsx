/**
 * src/components/StatusBar.tsx
 * =============================
 * Bottom status strip. Shows:
 *   — Current status message from store
 *   — Stealth mode toggle (setContentProtection)
 *   — App version
 *   — Logout button
 */

import React, { useState, useEffect } from 'react';
import { useStore } from '../lib/store';

interface StatusBarProps {
  onLogout: () => void;
}

export function StatusBar({ onLogout }: StatusBarProps) {
  const statusMessage  = useStore((s) => s.statusMessage);
  const [version,      setVersion]      = useState('');
  const [stealthMode,  setStealthMode]  = useState(true);

  useEffect(() => {
    window.electronAPI.getAppVersion().then(setVersion).catch(() => {});
  }, []);

  const toggleStealth = () => {
    const next = !stealthMode;
    setStealthMode(next);
    window.electronAPI.setContentProtection(next);
  };

  return (
    <div style={{
      height: '28px',
      background: 'var(--bg-surface)',
      borderTop: '1px solid var(--bg-border)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 10px',
      flexShrink: 0,
      gap: '8px',
    }}>
      {/* ── Left: status + user ─────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
        <span style={{
          width: '5px', height: '5px', borderRadius: '50%', flexShrink: 0,
          background: 'var(--status-ok)',
        }} />
        <span style={{
          color: 'var(--text-muted)', fontSize: '10px',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {statusMessage}
        </span>
      </div>

      {/* ── Right: controls ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
        {/* Stealth toggle */}
        <button
          onClick={toggleStealth}
          title={stealthMode ? 'Stealth ON — hidden from screen capture' : 'Stealth OFF'}
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '2px 4px', borderRadius: '3px',
            color: stealthMode ? 'var(--accent)' : 'var(--text-muted)',
            fontSize: '9.5px', letterSpacing: '0.06em', fontWeight: 500,
          }}
        >
          {stealthMode ? '◉ STEALTH' : '○ STEALTH'}
        </button>

        {/* Version */}
        {version && (
          <span style={{ color: 'var(--text-muted)', fontSize: '9px', fontFamily: 'var(--font-mono)' }}>
            v{version}
          </span>
        )}

        <button
          onClick={onLogout}
          title="Sign out"
          style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: '9.5px',
            padding: '2px 4px', borderRadius: '3px',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--text-secondary)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          ⏏ out
        </button>
      </div>
    </div>
  );
}

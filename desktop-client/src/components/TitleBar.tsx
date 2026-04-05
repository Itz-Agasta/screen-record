/**
 * src/components/TitleBar.tsx
 * ============================
 * Custom titlebar for the frameless BrowserWindow.
 * The drag region is the entire bar minus the control buttons.
 *
 * Recording indicator:
 *   When recording is active, a pulsing red dot replaces the app name
 *   so the user always has a peripheral indicator that capture is running.
 */

import React from 'react';
import { useStore, selectIsActive } from '../lib/store';

export function TitleBar() {
  const isRecording  = useStore(selectIsActive);
  const username = useStore((s) => s.username);

  const handleMinimise = async () => { await window.electronAPI.minimiseWindow(); };
  const handleToggleMaximise = async () => { await window.electronAPI.toggleMaximiseWindow(); };
  const handleClose    = async () => { await window.electronAPI.closeWindow(); };

  return (
    <div
      className="titlebar-drag flex items-center justify-between px-3"
      style={{
        height: '34px',
        background: 'var(--bg-surface)',
        borderBottom: '1px solid var(--bg-border)',
        flexShrink: 0,
        cursor: 'default',
      }}
    >
      {/* ── Left: app identity / recording badge ─────────────────── */}
      <div className="flex items-center gap-2" style={{ pointerEvents: 'none' }}>
        {isRecording ? (
          <>
            {/* Pulsing dot */}
            <span
              className="recording-ring"
              style={{
                position: 'relative',
                display: 'inline-block',
                width: '7px',
                height: '7px',
                borderRadius: '50%',
                background: 'var(--status-error)',
                flexShrink: 0,
              }}
            />
            <span style={{ color: 'var(--status-error)', fontWeight: 500, fontSize: '11px', letterSpacing: '0.06em' }}>
              RECORDING
            </span>
          </>
        ) : (
          <>
            <span style={{
              width: '7px', height: '7px', borderRadius: '50%',
              background: 'var(--accent)', display: 'inline-block', flexShrink: 0,
            }} />
            <span style={{ color: 'var(--text-secondary)', fontSize: '11px', letterSpacing: '0.08em', fontWeight: 500 }}>
              {`NEONEXUS · ${(username || 'USER').toUpperCase()}`}
            </span>
          </>
        )}
      </div>

      {/* ── Right: window control buttons ────────────────────────── */}
      <div
        className="titlebar-no-drag"
        style={{
          marginLeft: 'auto',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: '2px',
          pointerEvents: 'auto',
        }}
      >
        <button
          onClick={handleMinimise}
          title="Minimise"
          style={{
            width: '22px', height: '22px', borderRadius: '3px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elevated)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="10" height="1" viewBox="0 0 10 1" fill="none">
            <rect width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          onClick={handleToggleMaximise}
          title="Maximise / Restore"
          style={{
            width: '22px', height: '22px', borderRadius: '3px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elevated)')}
          onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <rect x="1" y="1" width="7" height="7" stroke="currentColor" strokeWidth="1.1" />
          </svg>
        </button>

        <button
          onClick={handleClose}
          title="Close"
          style={{
            width: '22px', height: '22px', borderRadius: '3px',
            background: 'transparent', border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)',
            opacity: 1,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = 'rgba(224,82,82,0.15)';
            e.currentTarget.style.color = 'var(--status-error)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M1 1l7 7M8 1L1 8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  );
}

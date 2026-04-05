/**
 * src/App.tsx
 * ===========
 * Root component.
 *
 * Responsibilities:
 *   • Auth routing: Login ↔ Dashboard
 *   • Persistent layout shell: TitleBar (top) + StatusBar (bottom)
 *   • Logout handler: clears store + notifies main process
 *
 * Layout is fixed at 100vh (the Electron window height) with:
 *   TitleBar    — 34px, always visible
 *   Page area   — flex 1, scrollable per-page
 *   StatusBar   — 28px, always visible
 *
 * No React Router is used — with only two views and no deep links needed,
 * a simple boolean state is cleaner and avoids a dependency.
 */

import React, { useState, useCallback } from 'react';
import { TitleBar }   from './components/TitleBar';
import { StatusBar }  from './components/StatusBar';
import { Login }      from './pages/Login';
import { Dashboard }  from './pages/Dashboard';
import { useStore }   from './lib/store';

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const logout = useStore((s) => s.logout);

  const handleLoginSuccess = useCallback(() => {
    setIsLoggedIn(true);
  }, []);

  const handleLogout = useCallback(async () => {
    await window.electronAPI.logout();
    logout();              // clear Zustand store
    setIsLoggedIn(false);
  }, [logout]);

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      width: '100%',
      overflow: 'hidden',
      background: 'var(--bg-base)',
    }}>
      {/* ── Titlebar — always rendered ─────────────────────────────── */}
      <TitleBar />

      {/* ── Page content ───────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {isLoggedIn ? (
          <Dashboard />
        ) : (
          <Login onLoginSuccess={handleLoginSuccess} />
        )}
      </div>

      {/* ── Status bar — always rendered ───────────────────────────── */}
      {isLoggedIn && <StatusBar onLogout={handleLogout} />}
    </div>
  );
}

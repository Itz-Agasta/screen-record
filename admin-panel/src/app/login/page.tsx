'use client';
// src/app/login/page.tsx

import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '@/lib/auth-context';

export default function LoginPage() {
  const { login, loading } = useAuth();
  const [username,    setUsername]    = useState('');
  const [password,    setPassword]    = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { usernameRef.current?.focus(); }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(username.trim(), password);
    } catch (err: any) {
      setError(err?.message ?? 'Login failed.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) return null;

  return (
    <div style={{
      minHeight: '100vh',
      background: 'var(--bg-canvas)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '24px',
    }}>
      {/* ── Decorative vertical rule ───────────────────────────────────── */}
      <div style={{
        position: 'fixed', left: '48px', top: 0, bottom: 0,
        width: '1px', background: 'var(--bg-border)',
        pointerEvents: 'none',
      }} />
      <div style={{
        position: 'fixed', right: '48px', top: 0, bottom: 0,
        width: '1px', background: 'var(--bg-border)',
        pointerEvents: 'none',
      }} />

      <div className="fade-up" style={{ width: '100%', maxWidth: '400px' }}>
        {/* ── Masthead ─────────────────────────────────────────────────── */}
        <div style={{ marginBottom: '40px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px',
          }}>
            <div style={{
              width: '32px', height: '32px',
              background: 'var(--accent)',
              borderRadius: '6px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M8 1L14 4.5v7L8 15 2 11.5v-7L8 1z"
                  stroke="#fff" strokeWidth="1" fill="none" strokeLinejoin="round"/>
                <circle cx="8" cy="8" r="2" fill="#fff"/>
              </svg>
            </div>
            <span style={{
              fontFamily: 'var(--font-display)', fontSize: '18px',
              fontWeight: 600, color: 'var(--ink-900)', letterSpacing: '-0.01em',
            }}>
              NeoNexus
            </span>
          </div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 700,
            color: 'var(--ink-900)', lineHeight: 1.15, letterSpacing: '-0.02em',
            marginBottom: '6px',
          }}>
            Administration<br />Panel
          </h1>
          <p style={{ color: 'var(--ink-500)', fontSize: '13.5px' }}>
            Restricted access — administrators only.
          </p>
        </div>

        {/* ── Form card ─────────────────────────────────────────────────── */}
        <div style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--bg-border)',
          borderRadius: 'var(--radius-lg)',
          padding: '28px',
          boxShadow: 'var(--shadow-elevated)',
        }}>
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <label style={labelStyle}>Admin ID</label>
              <input
                ref={usernameRef}
                className="field-input"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoCorrect="off"
                spellCheck={false}
                disabled={submitting}
                placeholder="admin_id"
              />
            </div>
            <div>
              <label style={labelStyle}>Password</label>
              <input
                className="field-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                disabled={submitting}
                placeholder="••••••••"
              />
            </div>

            {error && (
              <div style={{
                padding: '10px 12px',
                background: 'var(--wash-error)',
                border: '1px solid rgba(139,32,32,0.2)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--status-error)',
                fontSize: '13px',
              }}>
                {error}
              </div>
            )}

            <button
              type="submit"
              className="btn-primary"
              disabled={submitting || !username.trim() || !password}
              style={{ width: '100%', marginTop: '4px', justifyContent: 'center' }}
            >
              {submitting ? <Spinner /> : null}
              {submitting ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </div>

        {/* ── Footer ────────────────────────────────────────────────────── */}
        <p style={{
          textAlign: 'center', marginTop: '24px',
          color: 'var(--ink-300)', fontSize: '12px',
        }}>
          NeoNexus Innovations LLP — Internal system
        </p>
      </div>
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  display: 'block', marginBottom: '6px',
  fontSize: '12px', fontWeight: 500,
  color: 'var(--ink-500)', letterSpacing: '0.03em',
};

function Spinner() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
      style={{ animation: 'spin 0.75s linear infinite' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

'use client';
// src/app/dashboard/page.tsx

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiListUsers, AdminUser } from '@/lib/api';

export default function DashboardOverview() {
  const [users,   setUsers]   = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiListUsers()
      .then((u) => setUsers(u))
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const totalSessions  = users.reduce((a, u) => a + u.used_sessions, 0);
  const activeUsers    = users.filter((u) => u.is_active).length;
  const totalRemaining = users.reduce((a, u) => a + u.sessions_remaining, 0);

  return (
    <div style={{ padding: '32px 40px', maxWidth: '1100px' }}>
      {/* ── Page header ───────────────────────────────────────────────── */}
      <PageHeader title="Overview" subtitle="Platform-wide summary" />

      {/* ── Stat cards ────────────────────────────────────────────────── */}
      <div className="stagger" style={{
        display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '16px',
        marginBottom: '36px',
      }}>
        <StatCard label="Total Users" value={loading ? '—' : users.length} fade />
        <StatCard label="Active Users" value={loading ? '—' : activeUsers} fade />
        <StatCard label="Total Sessions Used" value={loading ? '—' : totalSessions} fade />
      </div>

      <div style={{
        marginBottom: '30px',
        padding: '16px 18px',
        background: 'var(--bg-card)',
        border: '1px solid var(--bg-border)',
        borderRadius: 'var(--radius-lg)',
        color: 'var(--ink-600)',
        fontSize: '13.5px',
      }}>
        Remaining session capacity across users: <strong>{loading ? '—' : totalRemaining}</strong>
      </div>

      {/* ── Users snapshot ────────────────────────────────────────────── */}
      <div style={{ marginTop: '36px' }}>
        <SectionHeader title="All Users" action={
          <Link href="/dashboard/users" style={{ color: 'var(--accent)', fontSize: '13px', textDecoration: 'none' }}>
            Manage users →
          </Link>
        } />

        {loading ? <SkeletonTable rows={4} cols={4} /> : (
          <TableCard>
            <thead>
              <tr>
                {['Username', 'Sessions used', 'Permitted', 'Status'].map((h) => (
                  <Th key={h}>{h}</Th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} style={{ cursor: 'pointer' }}
                  onClick={() => window.location.href = `/dashboard/users/${u.id}`}>
                  <Td><span style={{ fontWeight: 500, color: 'var(--ink-900)' }}>{u.username}</span></Td>
                  <Td mono>{u.used_sessions}</Td>
                  <Td mono>{u.permitted_sessions}</Td>
                  <Td>
                    <span style={{
                      fontSize: '11.5px', fontWeight: 500, padding: '2px 8px',
                      borderRadius: '99px',
                      background: u.is_active ? 'var(--wash-active)' : 'var(--wash-idle)',
                      color: u.is_active ? 'var(--status-active)' : 'var(--status-idle)',
                    }}>
                      {u.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableCard>
        )}
      </div>
    </div>
  );
}

// ── Shared sub-components ─────────────────────────────────────────────────────

function PageHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="fade-up" style={{ marginBottom: '28px' }}>
      <h1 style={{
        fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 700,
        color: 'var(--ink-900)', letterSpacing: '-0.02em', lineHeight: 1.2,
      }}>{title}</h1>
      <p style={{ color: 'var(--ink-500)', marginTop: '4px', fontSize: '13.5px' }}>{subtitle}</p>
    </div>
  );
}

function SectionHeader({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '12px' }}>
      <h2 style={{
        fontFamily: 'var(--font-display)', fontSize: '17px', fontWeight: 600,
        color: 'var(--ink-900)', letterSpacing: '-0.01em',
      }}>{title}</h2>
      {action}
    </div>
  );
}

function StatCard({ label, value, fade }: { label: string; value: string | number; fade?: boolean }) {
  return (
    <div className={fade ? 'fade-up' : ''} style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--bg-border)',
      borderRadius: 'var(--radius-lg)',
      padding: '20px 24px',
      boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ fontSize: '11.5px', color: 'var(--ink-300)', letterSpacing: '0.06em', fontWeight: 500, marginBottom: '8px' }}>
        {label.toUpperCase()}
      </div>
      <div style={{
        fontFamily: 'var(--font-display)', fontSize: '32px', fontWeight: 700,
        color: 'var(--ink-900)', letterSpacing: '-0.02em', lineHeight: 1,
      }}>
        {value}
      </div>
    </div>
  );
}

function TableCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="fade-up" style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--bg-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>{children}</table>
    </div>
  );
}

const tdStyle: React.CSSProperties = {
  padding: '11px 16px',
  borderBottom: '1px solid var(--bg-border)',
  fontSize: '13.5px',
  color: 'var(--ink-700)',
};

function Th({ children }: { children: React.ReactNode }) {
  return <th style={{
    ...tdStyle,
    background: 'var(--bg-inset)',
    color: 'var(--ink-500)',
    fontSize: '11.5px',
    fontWeight: 500,
    letterSpacing: '0.05em',
    textAlign: 'left',
    borderBottom: '1px solid var(--bg-border-dk)',
  }}>{children}</th>;
}

function Td({ children, mono, secondary }: { children: React.ReactNode; mono?: boolean; secondary?: boolean }) {
  return <td style={{
    ...tdStyle,
    fontFamily: mono ? 'var(--font-mono)' : undefined,
    fontSize: mono ? '12.5px' : tdStyle.fontSize,
    color: secondary ? 'var(--ink-500)' : tdStyle.color,
  }}>{children}</td>;
}

function SkeletonTable({ rows, cols }: { rows: number; cols: number }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--bg-border)',
      borderRadius: 'var(--radius-lg)', overflow: 'hidden',
    }}>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{
          display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`,
          gap: '12px', padding: '13px 16px',
          borderBottom: '1px solid var(--bg-border)',
        }}>
          {Array.from({ length: cols }).map((_, c) => (
            <div key={c} className="skeleton" style={{ height: 13, borderRadius: 3 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

'use client';
// src/app/dashboard/users/page.tsx

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { apiListUsers, AdminUser, formatDate } from '@/lib/api';

export default function UsersPage() {
  const [users,   setUsers]   = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search,  setSearch]  = useState('');

  useEffect(() => {
    apiListUsers()
      .then(setUsers)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const filtered = users.filter((u) =>
    u.username.toLowerCase().includes(search.toLowerCase()) ||
    u.email.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div style={{ padding: '32px 40px', maxWidth: '1100px' }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="fade-up" style={{
        display: 'flex', alignItems: 'flex-start',
        justifyContent: 'space-between', marginBottom: '28px', gap: '16px',
      }}>
        <div>
          <h1 style={{
            fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 700,
            color: 'var(--ink-900)', letterSpacing: '-0.02em',
          }}>Users</h1>
          <p style={{ color: 'var(--ink-500)', marginTop: '4px', fontSize: '13.5px' }}>
            {loading ? '…' : `${users.length} registered user${users.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <Link href="/dashboard/users/new">
          <button className="btn-primary">
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.6">
              <path d="M6.5 1.5v10M1.5 6.5h10" strokeLinecap="round"/>
            </svg>
            New User
          </button>
        </Link>
      </div>

      {/* ── Search ──────────────────────────────────────────────────── */}
      <div className="fade-up" style={{ marginBottom: '16px' }}>
        <input
          className="field-input"
          type="text"
          placeholder="Search by user ID or email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: '340px' }}
        />
      </div>

      {/* ── Table ───────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonRows />
      ) : (
        <div className="fade-up" style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--bg-border)',
          borderRadius: 'var(--radius-lg)',
          overflow: 'hidden',
          boxShadow: 'var(--shadow-card)',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['User ID', 'Email', 'Sessions', 'Capacity', 'Joined', 'Status', ''].map((h) => (
                  <th key={h} style={thStyle}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ ...tdBase, textAlign: 'center', color: 'var(--ink-300)', padding: '40px' }}>
                    {search ? `No users matching "${search}"` : 'No users yet.'}
                  </td>
                </tr>
              ) : filtered.map((user) => (
                <UserRow key={user.id} user={user} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const pct    = user.permitted_sessions > 0
    ? Math.min(1, user.used_sessions / user.permitted_sessions)
    : 0;
  const fillColor = pct >= 1 ? 'var(--status-error)' : pct >= 0.75 ? 'var(--status-process)' : 'var(--status-active)';

  return (
    <tr
      style={{ cursor: 'pointer', transition: 'background 0.1s' }}
      onClick={() => window.location.href = `/dashboard/users/${user.id}`}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-inset)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {/* Left accent bar fill on hover is done via the border-left */}
      <td style={{ ...tdBase, borderLeft: '3px solid transparent', transition: 'border-color 0.15s' }}
        onMouseEnter={(e) => (e.currentTarget.style.borderLeftColor = 'var(--accent)')}
        onMouseLeave={(e) => (e.currentTarget.style.borderLeftColor = 'transparent')}
      >
        <div style={{ fontWeight: 500, color: 'var(--ink-900)', fontSize: '13.5px' }}>{user.username}</div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--ink-300)', marginTop: '1px' }}>
          #{user.id}
        </div>
      </td>
      <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--ink-500)' }}>
        {user.email}
      </td>
      <td style={{ ...tdBase, fontFamily: 'var(--font-mono)', fontSize: '13px' }}>
        {user.used_sessions}
        <span style={{ color: 'var(--ink-300)' }}> / {user.permitted_sessions}</span>
      </td>
      <td style={{ ...tdBase, minWidth: '100px' }}>
        <div style={{ height: '4px', background: 'var(--bg-inset)', borderRadius: '2px', overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${pct * 100}%`,
            background: fillColor, borderRadius: '2px',
            transition: 'width 0.3s ease',
          }} />
        </div>
        <div style={{ fontSize: '10px', color: 'var(--ink-300)', marginTop: '3px' }}>
          {user.sessions_remaining} remaining
        </div>
      </td>
      <td style={{ ...tdBase, color: 'var(--ink-500)', fontSize: '12.5px' }}>
        {formatDate(user.created_at).split(',')[0]}
      </td>
      <td style={tdBase}>
        <span style={{
          fontSize: '11.5px', fontWeight: 500, padding: '2px 8px', borderRadius: '99px',
          background: user.is_active ? 'var(--wash-active)' : 'var(--wash-idle)',
          color: user.is_active ? 'var(--status-active)' : 'var(--status-idle)',
        }}>
          {user.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style={{ ...tdBase, color: 'var(--accent)', fontSize: '12.5px', whiteSpace: 'nowrap' }}>
        Edit →
      </td>
    </tr>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 16px',
  background: 'var(--bg-inset)',
  color: 'var(--ink-500)',
  fontSize: '11px',
  fontWeight: 500,
  letterSpacing: '0.06em',
  textAlign: 'left',
  borderBottom: '1px solid var(--bg-border-dk)',
  whiteSpace: 'nowrap',
};

const tdBase: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--bg-border)',
  verticalAlign: 'middle',
};

function SkeletonRows() {
  return (
    <div style={{ background: 'var(--bg-card)', border: '1px solid var(--bg-border)', borderRadius: 'var(--radius-lg)', overflow: 'hidden' }}>
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} style={{
          display: 'grid', gridTemplateColumns: '1fr 1.5fr 0.6fr 1fr 0.8fr 0.5fr',
          gap: '12px', padding: '15px 16px', borderBottom: '1px solid var(--bg-border)',
        }}>
          {[80, 140, 50, 90, 70, 40].map((w, j) => (
            <div key={j} className="skeleton" style={{ height: 13, width: w, borderRadius: 3 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

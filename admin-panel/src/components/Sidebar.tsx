'use client';
// src/components/Sidebar.tsx

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

const NAV = [
  {
    href:  '/dashboard',
    exact: true,
    icon:  <GridIcon />,
    label: 'Overview',
  },
  {
    href:  '/dashboard/users',
    exact: false,
    icon:  <UsersIcon />,
    label: 'Users',
  },
  {
    href:  '/dashboard/users/new',
    exact: true,
    icon:  <PlusIcon />,
    label: 'New User',
  },
  {
    href:  '/dashboard/sessions',
    exact: false,
    icon:  <SessionIcon />,
    label: 'Sessions',
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { logout } = useAuth();

  const isActive = (href: string, exact: boolean) =>
    exact ? pathname === href : pathname.startsWith(href);

  return (
    <aside style={{
      width: 'var(--sidebar-w)',
      background: 'var(--bg-card)',
      borderRight: '1px solid var(--bg-border)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
      position: 'fixed',
      top: 0, left: 0, bottom: 0,
      zIndex: 40,
    }}>
      {/* ── Brand ───────────────────────────────────────────────────── */}
      <div style={{
        padding: '20px 18px 16px',
        borderBottom: '1px solid var(--bg-border)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '9px' }}>
          <div style={{
            width: '28px', height: '28px', background: 'var(--accent)',
            borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 1L14 4.5v7L8 15 2 11.5v-7L8 1z"
                stroke="#fff" strokeWidth="1.1" fill="none" strokeLinejoin="round"/>
              <circle cx="8" cy="8" r="2" fill="#fff"/>
            </svg>
          </div>
          <div>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: '14px',
              fontWeight: 600, color: 'var(--ink-900)', lineHeight: 1.2,
            }}>
              NeoNexus
            </div>
            <div style={{ fontSize: '10px', color: 'var(--ink-300)', letterSpacing: '0.04em' }}>
              ADMIN PANEL
            </div>
          </div>
        </div>
      </div>

      {/* ── Nav ─────────────────────────────────────────────────────── */}
      <nav style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
        {NAV.map(({ href, exact, icon, label }) => {
          const active = isActive(href, exact);
          return (
            <Link key={href} href={href} style={{ textDecoration: 'none' }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: '9px',
                padding: '8px 10px',
                borderRadius: 'var(--radius-md)',
                background: active ? 'var(--accent-light)' : 'transparent',
                color: active ? 'var(--accent-text)' : 'var(--ink-500)',
                fontWeight: active ? 500 : 400,
                fontSize: '13.5px',
                transition: 'all 0.12s',
                cursor: 'pointer',
                borderLeft: active ? '2px solid var(--accent)' : '2px solid transparent',
              }}
              onMouseEnter={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'var(--bg-inset)';
                  e.currentTarget.style.color = 'var(--ink-700)';
                }
              }}
              onMouseLeave={(e) => {
                if (!active) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--ink-500)';
                }
              }}
              >
                <span style={{ opacity: active ? 1 : 0.6, flexShrink: 0 }}>{icon}</span>
                {label}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* ── Footer ──────────────────────────────────────────────────── */}
      <div style={{
        padding: '12px 10px',
        borderTop: '1px solid var(--bg-border)',
      }}>
        <button
          onClick={logout}
          className="btn-ghost"
          style={{ width: '100%', justifyContent: 'flex-start', fontSize: '13px' }}
        >
          <LogoutIcon />
          Sign out
        </button>
      </div>
    </aside>
  );
}

// ── Icons (inline SVG, 16×16) ─────────────────────────────────────────────────
function GridIcon() {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="1" y="1" width="5.5" height="5.5" rx="1"/>
    <rect x="8.5" y="1" width="5.5" height="5.5" rx="1"/>
    <rect x="1" y="8.5" width="5.5" height="5.5" rx="1"/>
    <rect x="8.5" y="8.5" width="5.5" height="5.5" rx="1"/>
  </svg>;
}
function UsersIcon() {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
    <circle cx="5.5" cy="4.5" r="2.5"/>
    <path d="M1 12.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" strokeLinecap="round"/>
    <circle cx="11" cy="4.5" r="2"/>
    <path d="M11 8.5c1.5 0 3 0.8 3 3" strokeLinecap="round"/>
  </svg>;
}
function PlusIcon() {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.4">
    <circle cx="7.5" cy="7.5" r="6"/>
    <path d="M7.5 4.5v6M4.5 7.5h6" strokeLinecap="round"/>
  </svg>;
}
function SessionIcon() {
  return <svg width="15" height="15" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="1.5" y="1.5" width="12" height="9" rx="1.5"/>
    <path d="M5 13.5h5M7.5 10.5v3" strokeLinecap="round"/>
    <path d="M4.5 5.5l1.5 1.5L9 4" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>;
}
function LogoutIcon() {
  return <svg width="14" height="14" viewBox="0 0 15 15" fill="none" stroke="currentColor" strokeWidth="1.3">
    <path d="M5 7.5h8M10 5l3 2.5L10 10" strokeLinecap="round" strokeLinejoin="round"/>
    <path d="M8 2H2.5A1.5 1.5 0 0 0 1 3.5v8A1.5 1.5 0 0 0 2.5 13H8" strokeLinecap="round"/>
  </svg>;
}

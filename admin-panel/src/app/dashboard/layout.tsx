// src/app/dashboard/layout.tsx
'use client';
import { Sidebar } from '@/components/Sidebar';
import { useAuth } from '@/lib/auth-context';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { loading, isAuthenticated } = useAuth();

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-canvas)',
      }}>
        <div className="skeleton" style={{ width: 120, height: 16 }} />
      </div>
    );
  }

  if (!isAuthenticated) return null; // route guard in auth-context handles redirect

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <main style={{
        marginLeft: 'var(--sidebar-w)',
        flex: 1,
        minHeight: '100vh',
        background: 'var(--bg-canvas)',
        display: 'flex',
        flexDirection: 'column',
      }}>
        {children}
      </main>
    </div>
  );
}

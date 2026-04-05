'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiListUsers, apiUpdateUser, AdminUser } from '@/lib/api';
import {
  SessionPlan,
  SessionState,
  parseStoredConfig,
  buildDefaultPlans,
  normalizePlans,
  buildStoredConfig,
} from '@/lib/session-config';

export default function SessionsTabPage() {
  const params = useSearchParams();
  const queryUserId = params.get('user');

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [plans, setPlans] = useState<SessionPlan[]>([]);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiListUsers()
      .then((list) => {
        setUsers(list);
        if (list.length === 0) return;
        const requested = queryUserId ? parseInt(queryUserId, 10) : NaN;
        const target = list.find((u) => u.id === requested) ?? list[0];
        setSelectedUserId(target.id);
      })
      .catch((e: any) => setError(e?.message ?? 'Failed to load users.'))
      .finally(() => setLoading(false));
  }, [queryUserId]);

  const selectedUser = useMemo(
    () => users.find((u) => u.id === selectedUserId) ?? null,
    [users, selectedUserId],
  );

  useEffect(() => {
    if (!selectedUser) {
      setPlans([]);
      setActiveSlot(null);
      return;
    }

    const parsed = parseStoredConfig(selectedUser.custom_prompt);
    if (parsed) {
      const count = Math.max(selectedUser.permitted_sessions, parsed.permitted_sessions, parsed.session_plans.length);
      setPlans(normalizePlans(parsed.session_plans, count));
      setActiveSlot(parsed.active_session_slot);
    } else {
      setPlans(buildDefaultPlans(
        selectedUser.permitted_sessions,
        selectedUser.resume_text ?? '',
        selectedUser.job_description ?? '',
        selectedUser.custom_prompt ?? '',
      ));
      setActiveSlot(null);
    }
    setMessage(null);
    setError(null);
  }, [selectedUser]);

  const persistState = async (nextPlans: SessionPlan[], nextActiveSlot: number | null) => {
    if (!selectedUser) return;

    const count = Math.max(selectedUser.permitted_sessions, nextPlans.length);
    const normalized = normalizePlans(nextPlans, count);
    const activePlan = nextActiveSlot
      ? normalized.find((p) => p.slot === nextActiveSlot && p.state === 'permitted') ?? null
      : null;

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const updated = await apiUpdateUser(selectedUser.id, {
        custom_prompt: JSON.stringify(buildStoredConfig(nextActiveSlot, normalized, count)),
        resume_text: activePlan?.resume_text || null,
        job_description: activePlan?.job_description || null,
      });

      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setPlans(normalized);
      setActiveSlot(nextActiveSlot);
      setMessage('Session state saved.');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save session state.');
    } finally {
      setSaving(false);
    }
  };

  const startSession = async (slot: number) => {
    const next = plans.map((p) => {
      if (p.slot === slot) return { ...p, state: 'permitted' as SessionState };
      if (p.state === 'ended') return p;
      return { ...p, state: 'draft' as SessionState };
    });
    await persistState(next, slot);
  };

  const endSession = async (slot: number) => {
    const next = plans.map((p) => (p.slot === slot ? { ...p, state: 'ended' as SessionState } : p));
    const nextActive = activeSlot === slot ? null : activeSlot;
    await persistState(next, nextActive);
  };

  if (loading) {
    return <div style={{ padding: '32px 40px' }}>Loading…</div>;
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: '980px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h1 style={{
          fontFamily: 'var(--font-display)',
          fontSize: '26px',
          fontWeight: 700,
          color: 'var(--ink-900)',
          letterSpacing: '-0.02em',
        }}>
          Sessions
        </h1>
        <p style={{ color: 'var(--ink-500)', marginTop: '4px', fontSize: '13.5px' }}>
          Start or end configured sessions directly for any user.
        </p>
      </div>

      <div style={{ marginBottom: '16px', display: 'flex', gap: '10px', alignItems: 'center' }}>
        <label style={{ fontSize: '12px', color: 'var(--ink-500)', fontWeight: 500 }}>User</label>
        <select
          className="field-input"
          value={selectedUserId ?? ''}
          onChange={(e) => setSelectedUserId(parseInt(e.target.value, 10))}
          style={{ maxWidth: '340px' }}
          disabled={saving}
        >
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.username} ({u.email})
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div style={{
          marginBottom: '12px',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--wash-error)',
          color: 'var(--status-error)',
          border: '1px solid rgba(139,32,32,0.2)',
          fontSize: '13px',
        }}>
          {error}
        </div>
      )}

      {message && (
        <div style={{
          marginBottom: '12px',
          padding: '10px 14px',
          borderRadius: 'var(--radius-md)',
          background: 'var(--wash-active)',
          color: 'var(--status-active)',
          border: '1px solid rgba(26,107,74,0.2)',
          fontSize: '13px',
        }}>
          {message}
        </div>
      )}

      {!selectedUser ? (
        <p style={{ color: 'var(--ink-500)', fontSize: '13px' }}>No users found.</p>
      ) : plans.length === 0 ? (
        <p style={{ color: 'var(--ink-500)', fontSize: '13px' }}>
          This user has no permitted session slots. Increase permitted sessions in User Details first.
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '14px' }}>
          {plans.map((plan) => (
            <div key={plan.slot} style={{
              border: '1px solid var(--bg-border)',
              background: 'var(--bg-card)',
              borderRadius: 'var(--radius-lg)',
              padding: '14px',
              boxShadow: 'var(--shadow-card)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
                <div style={{ fontWeight: 600, color: 'var(--ink-900)' }}>Session {plan.slot}</div>
                <SessionStateBadge state={plan.state} active={activeSlot === plan.slot} />
              </div>

              <div style={{ marginBottom: '10px' }}>
                <div style={{ color: 'var(--ink-400)', fontSize: '11px', marginBottom: '4px' }}>Job Name</div>
                <div style={{ color: 'var(--ink-700)', fontSize: '13px' }}>{plan.job_name || '—'}</div>
              </div>

              <div style={{ marginBottom: '12px' }}>
                <div style={{ color: 'var(--ink-400)', fontSize: '11px', marginBottom: '4px' }}>Summary</div>
                <div style={{ color: 'var(--ink-600)', fontSize: '12.5px' }}>{plan.summary || 'No summary yet.'}</div>
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={() => startSession(plan.slot)}
                  disabled={saving || plan.state === 'ended'}
                >
                  Start Session
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => endSession(plan.slot)}
                  disabled={saving || plan.state === 'ended'}
                >
                  End Session
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SessionStateBadge({ state, active }: { state: SessionState; active: boolean }) {
  const map: Record<SessionState, { label: string; bg: string; color: string }> = {
    draft: { label: 'Draft', bg: 'var(--wash-idle)', color: 'var(--status-idle)' },
    permitted: { label: 'Permitted', bg: 'var(--wash-active)', color: 'var(--status-active)' },
    ended: { label: 'Ended', bg: 'var(--wash-error)', color: 'var(--status-error)' },
  };
  const m = map[state];
  return (
    <span style={{
      fontSize: '11px',
      fontWeight: 600,
      padding: '2px 8px',
      borderRadius: '999px',
      background: m.bg,
      color: m.color,
      border: active ? '1px solid var(--accent)' : '1px solid transparent',
    }}>
      {active && state === 'permitted' ? 'Permitted (Active)' : m.label}
    </span>
  );
}

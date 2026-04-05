'use client';
// src/app/dashboard/users/[id]/page.tsx

import React, { useEffect, useState, use } from 'react';
import { useRouter } from 'next/navigation';
import {
  apiGetUser, apiUpdateUser,
  AdminUser, UpdateUserPayload,
} from '@/lib/api';
import {
  SessionState,
  SessionPlan,
  parseStoredConfig,
  buildDefaultPlans,
  normalizePlans,
  buildStoredConfig,
} from '@/lib/session-config';

export default function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id }     = use(params);
  const userId     = parseInt(id, 10);
  const router     = useRouter();

  const [user,    setUser]    = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving,  setSaving]  = useState(false);
  const [error,   setError]   = useState<string | null>(null);
  const [saved,   setSaved]   = useState(false);

  // Editable fields
  const [permitted,   setPermitted]   = useState('');
  const [isActive,    setIsActive]    = useState(true);
  const [newPassword, setNewPassword] = useState('');
  const [activeSlot,  setActiveSlot]  = useState<number | null>(null);
  const [plans,       setPlans]       = useState<SessionPlan[]>([]);
  const [sessionConfigDirty, setSessionConfigDirty] = useState(false);
  const [hasSavedSessionConfig, setHasSavedSessionConfig] = useState(false);

  useEffect(() => {
    apiGetUser(userId)
      .then((u) => {
        setUser(u);
        setPermitted(String(u.permitted_sessions));
        setIsActive(u.is_active);

        const parsed = parseStoredConfig(u.custom_prompt);
        if (parsed) {
          const count = Math.max(u.permitted_sessions, parsed.permitted_sessions, parsed.session_plans.length);
          const mergedUser = {
            ...u,
            permitted_sessions: count,
            sessions_remaining: Math.max(0, count - u.used_sessions),
          };
          setUser(mergedUser);
          setPermitted(String(count));
          const normalized = normalizePlans(parsed.session_plans, count);
          setPlans(normalized);
          setActiveSlot(parsed.active_session_slot);
          setHasSavedSessionConfig(true);
        } else {
          setPlans(buildDefaultPlans(u.permitted_sessions, u.resume_text ?? '', u.job_description ?? '', u.custom_prompt ?? ''));
          setActiveSlot(null);
          setHasSavedSessionConfig(false);
        }
        setSessionConfigDirty(false);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [userId]);

  const ensurePlanCount = (rawCount: string) => {
    const count = Math.max(0, parseInt(rawCount || '0', 10) || 0);
    setPlans((prev) => normalizePlans(prev, count));
    setActiveSlot((prev) => (prev && prev > count ? null : prev));
    setSessionConfigDirty(true);
  };

  const updatePlan = (slot: number, key: keyof SessionPlan, value: string) => {
    setPlans((prev) => prev.map((p) => (p.slot === slot ? { ...p, [key]: value } : p)));
    setSessionConfigDirty(true);
  };

  const permitSession = (slot: number) => {
    setPlans((prev) => prev.map((p) => {
      if (p.slot === slot) return { ...p, state: 'permitted' };
      if (p.state === 'ended') return p;
      return { ...p, state: 'draft' };
    }));
    setActiveSlot(slot);
    setSessionConfigDirty(true);
  };

  const endSession = (slot: number) => {
    setPlans((prev) => prev.map((p) => (p.slot === slot ? { ...p, state: 'ended' } : p)));
    setActiveSlot((prev) => (prev === slot ? null : prev));
    setSessionConfigDirty(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);

    const permittedSessions = parseInt(permitted, 10);
    if (isNaN(permittedSessions) || permittedSessions < 0) {
      setError('Permitted sessions must be 0 or greater.');
      setSaving(false);
      return;
    }

    const normalizedPlans = normalizePlans(plans, permittedSessions);
    const activePlan = activeSlot
      ? normalizedPlans.find((p) => p.slot === activeSlot && p.state === 'permitted') ?? null
      : null;

    const storedConfig = buildStoredConfig(activeSlot, normalizedPlans, permittedSessions);

    const payload: UpdateUserPayload = {
      permitted_sessions: permittedSessions,
      resume_text:        null,
      job_description:    null,
      custom_prompt:      JSON.stringify(storedConfig),
      is_active:          isActive,
    };

    if (activePlan) {
      payload.resume_text = activePlan.resume_text || null;
      payload.job_description = activePlan.job_description || null;
    }

    if (newPassword) {
      if (newPassword.length < 8) {
        setError('New password must be at least 8 characters.');
        setSaving(false);
        return;
      }
      payload.password = newPassword;
    }

    try {
      const updated = await apiUpdateUser(userId, payload);
      const savedCount = permittedSessions;
      setUser({
        ...updated,
        permitted_sessions: savedCount,
        sessions_remaining: Math.max(0, savedCount - updated.used_sessions),
      });
      setPermitted(String(savedCount));
      setPlans(normalizedPlans);
      setHasSavedSessionConfig(true);
      setSessionConfigDirty(false);
      setSaved(true);
      setNewPassword('');
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err?.message ?? 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingSkeleton />;
  if (!user)   return (
    <div style={{ padding: 40, color: 'var(--status-error)' }}>{error ?? 'User not found.'}</div>
  );

  const pct = user.permitted_sessions > 0
    ? Math.min(1, user.used_sessions / user.permitted_sessions) : 0;

  return (
    <div style={{ padding: '32px 40px', maxWidth: '860px' }}>
      {/* ── Back + header ────────────────────────────────────────────── */}
      <div className="fade-up" style={{ marginBottom: '28px' }}>
        <button onClick={() => router.back()} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--ink-300)', fontSize: '13px', padding: 0,
          marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '4px',
        }}>← Users</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <div style={{
            width: '44px', height: '44px', borderRadius: '10px',
            background: 'var(--accent-light)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: 'var(--font-display)', fontSize: '18px',
            fontWeight: 700, color: 'var(--accent)',
            flexShrink: 0,
          }}>
            {user.username[0].toUpperCase()}
          </div>
          <div>
            <h1 style={{
              fontFamily: 'var(--font-display)', fontSize: '24px', fontWeight: 700,
              color: 'var(--ink-900)', letterSpacing: '-0.02em', lineHeight: 1.2,
            }}>{user.username}</h1>
            <p style={{ color: 'var(--ink-500)', fontSize: '13px', marginTop: '2px', fontFamily: 'var(--font-mono)' }}>
              {user.email} · ID #{user.id}
            </p>
          </div>
        </div>
      </div>

      {/* ── Session usage card ──────────────────────────────────────── */}
      <div className="fade-up" style={{
        background: 'var(--bg-card)', border: '1px solid var(--bg-border)',
        borderRadius: 'var(--radius-lg)', padding: '18px 22px',
        boxShadow: 'var(--shadow-card)', marginBottom: '24px',
        display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: '20px',
      }}>
        {[
          { label: 'Used',      value: user.used_sessions },
          { label: 'Permitted', value: user.permitted_sessions },
          { label: 'Remaining', value: user.sessions_remaining },
        ].map(({ label, value }) => (
          <div key={label}>
            <div style={{ fontSize: '10.5px', color: 'var(--ink-300)', letterSpacing: '0.07em', fontWeight: 500 }}>
              {label.toUpperCase()}
            </div>
            <div style={{
              fontFamily: 'var(--font-display)', fontSize: '28px', fontWeight: 700,
              color: 'var(--ink-900)', letterSpacing: '-0.02em', marginTop: '4px',
            }}>{value}</div>
          </div>
        ))}
        <div style={{ gridColumn: '1/-1' }}>
          <div style={{ height: '5px', background: 'var(--bg-inset)', borderRadius: '3px', overflow: 'hidden' }}>
            <div style={{
              height: '100%', width: `${pct * 100}%`,
              background: pct >= 1 ? 'var(--status-error)' : pct >= 0.75 ? 'var(--status-process)' : 'var(--status-active)',
              borderRadius: '3px', transition: 'width 0.4s ease',
            }} />
          </div>
        </div>
      </div>

      {/* ── Edit form ───────────────────────────────────────────────── */}
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

        <SectionCard title="Access & Account">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <FormField label="Permitted Sessions">
              <input className="field-input" type="number" min="0"
                value={permitted}
                onChange={(e) => {
                  setPermitted(e.target.value);
                  ensurePlanCount(e.target.value);
                }}
                disabled={saving} />
            </FormField>
            <FormField label="Account Status">
              <select
                className="field-input"
                value={isActive ? 'active' : 'inactive'}
                onChange={(e) => setIsActive(e.target.value === 'active')}
                disabled={saving}
              >
                <option value="active">Active</option>
                <option value="inactive">Inactive (deactivated)</option>
              </select>
            </FormField>
          </div>
          <FormField label="New Password" hint="Leave blank to keep the current password">
            <input className="field-input" type="password" value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="••••••••" autoComplete="new-password" disabled={saving} />
          </FormField>
        </SectionCard>

        <SectionCard title="Session Configuration" subtitle="Configure each allowed session and mark which one is currently permitted.">
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: '10px',
            padding: '10px 12px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-card)',
            border: '1px solid var(--bg-border)',
          }}>
            <span style={{ color: 'var(--ink-500)', fontSize: '12px' }}>
              {sessionConfigDirty ? 'Unsaved session changes. Save to unlock Permit/End controls.' : 'Session configuration saved.'}
            </span>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => router.push(`/dashboard/sessions?user=${userId}`)}
              disabled={saving}
            >
              Open Sessions Tab
            </button>
          </div>

          {plans.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--ink-500)', fontSize: '13px' }}>
              Set permitted sessions above to start adding session details.
            </p>
          ) : (
            plans.map((plan) => (
              <div key={plan.slot} style={{
                border: '1px solid var(--bg-border)',
                borderRadius: 'var(--radius-md)',
                padding: '14px',
                background: 'var(--bg-inset)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ fontWeight: 600, color: 'var(--ink-800)', fontSize: '13.5px' }}>
                    Session {plan.slot}
                  </div>
                  <SessionStateBadge state={plan.state} active={activeSlot === plan.slot} />
                </div>

                <FormField label="Job Name">
                  <input
                    className="field-input"
                    value={plan.job_name}
                    onChange={(e) => updatePlan(plan.slot, 'job_name', e.target.value)}
                    placeholder="Example: AIML Session"
                    disabled={saving}
                  />
                </FormField>

                <FormField label="Resume">
                  <textarea
                    className="field-input"
                    rows={4}
                    value={plan.resume_text}
                    onChange={(e) => updatePlan(plan.slot, 'resume_text', e.target.value)}
                    placeholder="Paste or upload then paste resume text"
                    disabled={saving}
                  />
                </FormField>

                <FormField label="Job Description">
                  <textarea
                    className="field-input"
                    rows={3}
                    value={plan.job_description}
                    onChange={(e) => updatePlan(plan.slot, 'job_description', e.target.value)}
                    placeholder="Example: AIML Engineer"
                    disabled={saving}
                  />
                </FormField>

                <FormField label="Prompt">
                  <textarea
                    className="field-input"
                    rows={3}
                    value={plan.prompt}
                    onChange={(e) => updatePlan(plan.slot, 'prompt', e.target.value)}
                    placeholder="Custom prompt for this session"
                    disabled={saving}
                  />
                </FormField>

                <FormField label="Summary">
                  <textarea
                    className="field-input"
                    rows={3}
                    value={plan.summary}
                    onChange={(e) => updatePlan(plan.slot, 'summary', e.target.value)}
                    placeholder="Summary will be stored when session ends"
                    disabled={saving}
                  />
                </FormField>

                {hasSavedSessionConfig && !sessionConfigDirty ? (
                  <div style={{ display: 'flex', gap: '10px' }}>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={() => permitSession(plan.slot)}
                      disabled={saving || plan.state === 'ended'}
                    >
                      Permit Session
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
                ) : (
                  <p style={{ margin: 0, color: 'var(--ink-400)', fontSize: '12px' }}>
                    Save session configuration first to enable Permit Session and End Session.
                  </p>
                )}
              </div>
            ))
          )}
        </SectionCard>

        {/* Feedback */}
        {error && (
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--wash-error)', border: '1px solid rgba(139,32,32,0.2)',
            color: 'var(--status-error)', fontSize: '13px',
          }}>{error}</div>
        )}
        {saved && (
          <div style={{
            padding: '10px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--wash-active)', border: '1px solid rgba(26,107,74,0.2)',
            color: 'var(--status-active)', fontSize: '13px',
          }}>Changes saved successfully.</div>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? '…' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SectionCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-card)', border: '1px solid var(--bg-border)',
      borderRadius: 'var(--radius-lg)', overflow: 'hidden', boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{ padding: '13px 20px', borderBottom: '1px solid var(--bg-border)', background: 'var(--bg-inset)' }}>
        <div style={{ fontWeight: 600, fontSize: '13.5px', color: 'var(--ink-900)' }}>{title}</div>
        {subtitle && <div style={{ fontSize: '12px', color: 'var(--ink-500)', marginTop: '2px' }}>{subtitle}</div>}
      </div>
      <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: '14px' }}>{children}</div>
    </div>
  );
}

function FormField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: 500, color: 'var(--ink-500)' }}>
        {label}
      </label>
      {children}
      {hint && <p style={{ marginTop: '4px', fontSize: '11.5px', color: 'var(--ink-300)' }}>{hint}</p>}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ padding: '32px 40px', maxWidth: 860 }}>
      {[200, 100, 300, 200, 150].map((w, i) => (
        <div key={i} className="skeleton" style={{ height: 16, width: w, marginBottom: 14, borderRadius: 4 }} />
      ))}
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

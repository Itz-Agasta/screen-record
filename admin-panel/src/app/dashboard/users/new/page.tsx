'use client';
// src/app/dashboard/users/new/page.tsx

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiCreateUser, apiUpdateUser } from '@/lib/api';
import {
  SessionPlan,
  buildDefaultPlans,
  buildStoredConfig,
  normalizePlans,
} from '@/lib/session-config';

interface FormState {
  username:           string;
  email:              string;
  password:           string;
  confirmPassword:    string;
  permitted_sessions: string;
  resume_text:        string;
  job_description:    string;
  custom_prompt:      string;
}

const INITIAL: FormState = {
  username: '', email: '', password: '', confirmPassword: '',
  permitted_sessions: '5',
  resume_text: '', job_description: '', custom_prompt: '',
};

export default function NewUserPage() {
  const router = useRouter();
  const [form,       setForm]       = useState<FormState>(INITIAL);
  const [submitting, setSubmitting] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [success,    setSuccess]    = useState<string | null>(null);
  const [sessionPlans, setSessionPlans] = useState<SessionPlan[]>(
    buildDefaultPlans(5, '', '', ''),
  );

  const set = (k: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    const sessions = parseInt(form.permitted_sessions, 10);
    const count = Number.isNaN(sessions) ? 0 : Math.max(0, sessions);
    setSessionPlans((prev) => normalizePlans(prev, count));
  }, [form.permitted_sessions]);

  const updatePlan = (slot: number, key: keyof SessionPlan, value: string) => {
    setSessionPlans((prev) => prev.map((plan) => (
      plan.slot === slot ? { ...plan, [key]: value } : plan
    )));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    // ── Client-side validation ─────────────────────────────────────────
    if (!form.username.trim())  return setError('User ID is required.');
    if (!form.email.trim())     return setError('Email is required.');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirmPassword) return setError('Passwords do not match.');
    const sessions = parseInt(form.permitted_sessions, 10);
    if (isNaN(sessions) || sessions < 0) return setError('Permitted sessions must be 0 or greater.');

    const normalizedPlans = normalizePlans(sessionPlans, sessions);
    const effectivePlans = normalizedPlans.map((plan) => (
      plan.slot === 1
        ? {
            ...plan,
            resume_text: plan.resume_text || form.resume_text,
            job_description: plan.job_description || form.job_description,
            prompt: plan.prompt || form.custom_prompt,
          }
        : plan
    ));
    const activePlan = effectivePlans.find((plan) => plan.slot === 1) ?? null;

    setSubmitting(true);
    try {
      // ── 1. Create the user account ───────────────────────────────────
      const user = await apiCreateUser({
        username:           form.username.trim(),
        email:              form.email.trim(),
        password:           form.password,
        permitted_sessions: sessions,
      });

      // ── 2. PATCH AI context fields in one call (they aren't in the create schema) ──
      const storedConfig = buildStoredConfig(null, effectivePlans, sessions);

      if (form.resume_text || form.job_description || form.custom_prompt || effectivePlans.length > 0) {
        await apiUpdateUser(user.id, {
          resume_text:     activePlan?.resume_text || form.resume_text || null,
          job_description: activePlan?.job_description || form.job_description || null,
          custom_prompt:   JSON.stringify(storedConfig),
        });
      }

      setSuccess(`User "${user.username}" created successfully.`);
      setTimeout(() => router.push(`/dashboard/users/${user.id}`), 1200);

    } catch (err: any) {
      setError(err?.message ?? 'Failed to create user.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '32px 40px', maxWidth: '740px' }}>
      {/* ── Header ──────────────────────────────────────────────────── */}
      <div className="fade-up" style={{ marginBottom: '32px' }}>
        <button
          onClick={() => router.back()}
          style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--ink-300)', fontSize: '13px', padding: 0, marginBottom: '12px',
            display: 'flex', alignItems: 'center', gap: '4px' }}
        >
          ← Back
        </button>
        <h1 style={{
          fontFamily: 'var(--font-display)', fontSize: '26px', fontWeight: 700,
          color: 'var(--ink-900)', letterSpacing: '-0.02em',
        }}>Create New User</h1>
        <p style={{ color: 'var(--ink-500)', marginTop: '5px', fontSize: '13.5px' }}>
          Account credentials, session allowance, and AI context for the desktop client.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="fade-up stagger" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>

        {/* ── Section: Account ────────────────────────────────────────── */}
        <FormSection title="Account Details">
          <TwoCol>
                <Field label="User ID" required>
              <input className="field-input" type="text" value={form.username}
                  onChange={set('username')} placeholder="user123"
                autoComplete="off" spellCheck={false} disabled={submitting} />
            </Field>
            <Field label="Email" required>
              <input className="field-input" type="email" value={form.email}
                onChange={set('email')} placeholder="jane@company.com"
                disabled={submitting} />
            </Field>
          </TwoCol>
          <TwoCol>
            <Field label="Password" required hint="Minimum 8 characters">
              <input className="field-input" type="password" value={form.password}
                onChange={set('password')} placeholder="••••••••"
                autoComplete="new-password" disabled={submitting} />
            </Field>
            <Field label="Confirm Password" required>
              <input className="field-input" type="password" value={form.confirmPassword}
                onChange={set('confirmPassword')} placeholder="••••••••"
                autoComplete="new-password" disabled={submitting} />
            </Field>
          </TwoCol>
          <Field label="Permitted Sessions" required hint="Number of session slots this user can be assigned">
            <input className="field-input" type="number" min="0" max="9999"
              value={form.permitted_sessions}
              onChange={set('permitted_sessions')}
              style={{ maxWidth: '120px' }} disabled={submitting} />
          </Field>
        </FormSection>

        {/* ── Section: AI Context + Sessions ─────────────────────────── */}
        <FormSection
          title="AI Context"
          subtitle="These values seed Session 1. You can override them in the session boxes below."
        >
          <Field label="Résumé / CV Text" hint="Paste the candidate's full résumé text">
            <textarea className="field-input" rows={7} value={form.resume_text}
              onChange={set('resume_text')}
              placeholder="John Doe&#10;Senior Software Engineer&#10;5 years experience in…"
              disabled={submitting} />
          </Field>
          <Field label="Job Description" hint="Paste the full JD for the role being interviewed for">
            <textarea className="field-input" rows={6} value={form.job_description}
              onChange={set('job_description')}
              placeholder="We are looking for a Senior Engineer to lead…"
              disabled={submitting} />
          </Field>
          <Field
            label="Custom System Prompt"
            hint="Used as the starting prompt for Session 1 unless you override it below."
          >
            <textarea className="field-input" rows={5} value={form.custom_prompt}
              onChange={set('custom_prompt')}
              placeholder="You are an expert interview coach. Focus particularly on…"
              disabled={submitting} />
          </Field>
        </FormSection>

        <FormSection
          title="Session Boxes"
          subtitle="A card is shown for every permitted session. Fill in as many as you add."
        >
          {sessionPlans.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--ink-500)', fontSize: '13px' }}>
              Set permitted sessions above to generate session boxes.
            </p>
          ) : (
            sessionPlans.map((plan) => (
              <div
                key={plan.slot}
                style={{
                  border: '1px solid var(--bg-border)',
                  borderRadius: 'var(--radius-md)',
                  padding: '14px',
                  background: 'var(--bg-inset)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '12px',
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--ink-800)', fontSize: '13.5px' }}>
                  Session {plan.slot}
                </div>

                <Field label="Job Name">
                  <input
                    className="field-input"
                    value={plan.job_name}
                    onChange={(e) => updatePlan(plan.slot, 'job_name', e.target.value)}
                    placeholder="Example: AIML Session"
                    disabled={submitting}
                  />
                </Field>

                <Field label="Résumé / CV Text">
                  <textarea
                    className="field-input"
                    rows={4}
                    value={plan.resume_text}
                    onChange={(e) => updatePlan(plan.slot, 'resume_text', e.target.value)}
                    placeholder="Paste the candidate's resume for this session"
                    disabled={submitting}
                  />
                </Field>

                <Field label="Job Description">
                  <textarea
                    className="field-input"
                    rows={3}
                    value={plan.job_description}
                    onChange={(e) => updatePlan(plan.slot, 'job_description', e.target.value)}
                    placeholder="Paste the role description for this session"
                    disabled={submitting}
                  />
                </Field>

                <Field label="Prompt">
                  <textarea
                    className="field-input"
                    rows={3}
                    value={plan.prompt}
                    onChange={(e) => updatePlan(plan.slot, 'prompt', e.target.value)}
                    placeholder="Custom prompt for this session"
                    disabled={submitting}
                  />
                </Field>

                <Field label="Summary">
                  <textarea
                    className="field-input"
                    rows={3}
                    value={plan.summary}
                    onChange={(e) => updatePlan(plan.slot, 'summary', e.target.value)}
                    placeholder="Session summary placeholder"
                    disabled={submitting}
                  />
                </Field>
              </div>
            ))
          )}
        </FormSection>

        {/* ── Feedback ────────────────────────────────────────────────── */}
        {error && (
          <div style={{
            padding: '11px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--wash-error)', border: '1px solid rgba(139,32,32,0.2)',
            color: 'var(--status-error)', fontSize: '13px',
          }}>
            {error}
          </div>
        )}
        {success && (
          <div style={{
            padding: '11px 14px', borderRadius: 'var(--radius-md)',
            background: 'var(--wash-active)', border: '1px solid rgba(26,107,74,0.2)',
            color: 'var(--status-active)', fontSize: '13px',
          }}>
            {success}
          </div>
        )}

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', gap: '10px', paddingBottom: '40px' }}>
          <button type="submit" className="btn-primary" disabled={submitting}>
            {submitting ? <SmallSpinner /> : null}
            {submitting ? 'Creating…' : 'Create User'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => router.back()} disabled={submitting}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Form primitives ───────────────────────────────────────────────────────────

function FormSection({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--bg-border)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-card)',
    }}>
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--bg-border)',
        background: 'var(--bg-inset)',
      }}>
        <div style={{ fontWeight: 600, color: 'var(--ink-900)', fontSize: '13.5px' }}>{title}</div>
        {subtitle && <div style={{ color: 'var(--ink-500)', fontSize: '12.5px', marginTop: '2px' }}>{subtitle}</div>}
      </div>
      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {children}
      </div>
    </div>
  );
}

function TwoCol({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
      {children}
    </div>
  );
}

function Field({
  label, required, hint, children,
}: { label: string; required?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{
        display: 'block', marginBottom: '6px',
        fontSize: '12px', fontWeight: 500, color: 'var(--ink-500)', letterSpacing: '0.02em',
      }}>
        {label}
        {required && <span style={{ color: 'var(--accent)', marginLeft: '3px' }}>*</span>}
      </label>
      {children}
      {hint && <p style={{ marginTop: '4px', fontSize: '11.5px', color: 'var(--ink-300)' }}>{hint}</p>}
    </div>
  );
}

function SmallSpinner() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
      style={{ animation: 'spin 0.75s linear infinite' }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" opacity="0.2"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
    </svg>
  );
}

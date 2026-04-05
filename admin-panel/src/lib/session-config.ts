export type SessionState = 'draft' | 'permitted' | 'ended';

export interface SessionPlan {
  slot: number;
  job_name: string;
  resume_text: string;
  job_description: string;
  prompt: string;
  summary: string;
  state: SessionState;
}

export interface StoredConfig {
  version: 1;
  permitted_sessions: number;
  active_session_slot: number | null;
  session_plans: SessionPlan[];
}

export function parseStoredConfig(raw: string | null): StoredConfig | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    if (parsed.version !== 1 || !Array.isArray(parsed.session_plans)) return null;
    const plannedCount = parsed.session_plans.length;
    const configuredCount = Math.max(
      typeof parsed.permitted_sessions === 'number' ? parsed.permitted_sessions : 0,
      plannedCount,
    );
    return {
      version: 1,
      permitted_sessions: configuredCount,
      active_session_slot: typeof parsed.active_session_slot === 'number' ? parsed.active_session_slot : null,
      session_plans: normalizePlans(parsed.session_plans as SessionPlan[], configuredCount).map((p, i) => ({
        slot: i + 1,
        job_name: p.job_name ?? '',
        resume_text: p.resume_text ?? '',
        job_description: p.job_description ?? '',
        prompt: p.prompt ?? '',
        summary: p.summary ?? '',
        state: p.state === 'permitted' || p.state === 'ended' ? p.state : 'draft',
      })),
    };
  } catch {
    return null;
  }
}

export function buildDefaultPlans(
  count: number,
  resumeText: string,
  jobDescription: string,
  promptText: string,
): SessionPlan[] {
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({
    slot: i + 1,
    job_name: '',
    resume_text: i === 0 ? resumeText : '',
    job_description: i === 0 ? jobDescription : '',
    prompt: i === 0 ? promptText : '',
    summary: '',
    state: 'draft',
  }));
}

export function normalizePlans(source: SessionPlan[], count: number): SessionPlan[] {
  const desired = Math.max(0, count);
  const out: SessionPlan[] = [];
  for (let i = 0; i < desired; i += 1) {
    const existing = source[i];
    out.push(existing ? { ...existing, slot: i + 1 } : {
      slot: i + 1,
      job_name: '',
      resume_text: '',
      job_description: '',
      prompt: '',
      summary: '',
      state: 'draft',
    });
  }
  return out;
}

export function buildStoredConfig(
  activeSlot: number | null,
  plans: SessionPlan[],
  permittedSessions: number,
): StoredConfig {
  return {
    version: 1,
    permitted_sessions: Math.max(0, permittedSessions),
    active_session_slot: activeSlot,
    session_plans: plans,
  };
}

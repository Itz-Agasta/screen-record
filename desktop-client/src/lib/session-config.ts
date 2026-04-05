export type SessionState = 'draft' | 'permitted' | 'ended';

export interface SessionPlan {
  slot: number;
  state: SessionState;
}

export interface StoredSessionConfig {
  version: 1;
  active_session_slot: number | null;
  session_plans: SessionPlan[];
}

export function parseStoredSessionConfig(raw: string | null): StoredSessionConfig | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Partial<StoredSessionConfig>;
    if (parsed.version !== 1 || !Array.isArray(parsed.session_plans)) return null;

    return {
      version: 1,
      active_session_slot: typeof parsed.active_session_slot === 'number' ? parsed.active_session_slot : null,
      session_plans: parsed.session_plans.map((plan, index) => ({
        slot: typeof plan.slot === 'number' ? plan.slot : index + 1,
        state: plan.state === 'permitted' || plan.state === 'ended' ? plan.state : 'draft',
      })),
    };
  } catch {
    return null;
  }
}

export function hasPermittedSession(raw: string | null): boolean {
  const parsed = parseStoredSessionConfig(raw);
  return !!parsed?.session_plans.some((plan) => plan.state === 'permitted');
}
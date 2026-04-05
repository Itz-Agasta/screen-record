/**
 * src/lib/api.ts
 * ==============
 * Thin REST client for calls the renderer makes directly to the FastAPI
 * backend before handing the JWT to the main process.
 *
 * IMPORTANT: After login, the JWT is passed to the main process via IPC
 * (window.electronAPI.login) and is NEVER stored in renderer memory again.
 * All subsequent authenticated operations go through IPC.
 *
 * Post-login user profile calls also go through this client.
 */

export const BACKEND_BASE_URL = (import.meta.env.VITE_BACKEND_URL as string) || 'http://127.0.0.1:8000';
const API_TIMEOUT_MS = 12000;

// ── Typed response shapes ─────────────────────────────────────────────────────

export interface LoginResponse {
  access_token: string;
  token_type:   string;
  role:         'admin' | 'user';
  user_id:      number;
}

export interface UserMeResponse {
  id:                 number;
  username:           string;
  email:              string;
  permitted_sessions: number;
  used_sessions:      number;
  sessions_remaining: number;
  custom_prompt:      string | null;
  is_active:          boolean;
}


// ── Helpers ───────────────────────────────────────────────────────────────────

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const buildCandidates = (base: string): string[] => {
    const raw = (base || '').trim().replace(/\/+$/, '');
    if (!raw) return ['http://127.0.0.1:8000'];
    const set = new Set<string>([raw]);
    try {
      const u = new URL(raw);
      if (u.hostname === 'localhost') {
        u.hostname = '127.0.0.1';
        set.add(u.toString().replace(/\/+$/, ''));
      } else if (u.hostname === '127.0.0.1') {
        u.hostname = 'localhost';
        set.add(u.toString().replace(/\/+$/, ''));
      } else if (u.hostname === '0.0.0.0') {
        u.hostname = '127.0.0.1';
        set.add(u.toString().replace(/\/+$/, ''));
      }
    } catch {
      // keep raw candidate only
    }
    return Array.from(set);
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || undefined),
  };

  let res: Response | null = null;
  let lastErr: any = null;
  for (const base of buildCandidates(BACKEND_BASE_URL)) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      res = await fetch(`${base}${path}`, {
        ...options,
        headers,
        signal: controller.signal,
      });
      break;
    } catch (err: any) {
      lastErr = err;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!res) {
    if (lastErr?.name === 'AbortError') {
      throw new Error('Backend request timed out. Please check backend/API connectivity.');
    }
    throw new Error(lastErr?.message || 'Failed to reach backend API.');
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      detail = body?.detail ?? detail;
    } catch { /* ignore parse error */ }
    throw new Error(detail);
  }

  return res.json() as Promise<T>;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * POST /auth/login
 * Returns the JWT + role.  Renderer immediately hands the token to main
 * process and discards it from its own scope.
 */
export async function apiLogin(
  username: string,
  password: string,
): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body:   JSON.stringify({ username, password }),
  });
}

/**
 * GET /users/me
 * Called once after login to populate the store with username + session counts.
 * Requires the token — passed as a parameter so the renderer can use it
 * for this one call before handing it to main.
 */
export async function apiGetMe(token: string): Promise<UserMeResponse> {
  return request<UserMeResponse>('/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}


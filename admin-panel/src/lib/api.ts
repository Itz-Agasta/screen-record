// src/lib/api.ts
// Typed REST client for the FastAPI backend.
// Token is read from sessionStorage (set on login, cleared on logout).
// All requests go through the `apiFetch` wrapper which injects the JWT.

const BASE = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://localhost:8000';
const API_TIMEOUT_MS = 8000;

// ── Token helpers ─────────────────────────────────────────────────────────────
export const TOKEN_KEY = 'nn_admin_token';

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}
export function setToken(t: string) { sessionStorage.setItem(TOKEN_KEY, t); }
export function clearToken()        { sessionStorage.removeItem(TOKEN_KEY); }

// ── Core fetch wrapper ────────────────────────────────────────────────────────
async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
  requireAuth = true,
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> ?? {}),
  };
  if (requireAuth) {
    const token = getToken();
    if (!token) throw new Error('Not authenticated');
    headers['Authorization'] = `Bearer ${token}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new Error('Request timed out. Please check if the backend is running.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try { detail = (await res.json()).detail ?? detail; } catch {}
    throw new Error(detail);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface TokenResponse {
  access_token: string;
  token_type:   string;
  role:         'admin' | 'user';
  user_id:      number;
}

export interface AdminUser {
  id:                 number;
  username:           string;
  email:              string;
  permitted_sessions: number;
  used_sessions:      number;
  sessions_remaining: number;
  resume_text:        string | null;
  job_description:    string | null;
  custom_prompt:      string | null;
  is_active:          boolean;
  created_at:         string;
  updated_at:         string;
}

export interface CreateUserPayload {
  username:           string;
  email:              string;
  password:           string;
  permitted_sessions: number;
}

export interface UpdateUserPayload {
  email?:              string;
  password?:           string;
  permitted_sessions?: number;
  resume_text?:        string | null;
  job_description?:    string | null;
  custom_prompt?:      string | null;
  is_active?:          boolean;
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function apiAdminLogin(
  username: string,
  password: string,
): Promise<TokenResponse> {
  return apiFetch<TokenResponse>(
    '/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    false,
  );
}

// ── Users ─────────────────────────────────────────────────────────────────────
export const apiListUsers   = () =>
  apiFetch<AdminUser[]>('/admin/users');

export const apiGetUser     = (id: number) =>
  apiFetch<AdminUser>(`/admin/users/${id}`);

export const apiCreateUser  = (payload: CreateUserPayload) =>
  apiFetch<AdminUser>('/admin/users', { method: 'POST', body: JSON.stringify(payload) });

export const apiUpdateUser  = (id: number, payload: UpdateUserPayload) =>
  apiFetch<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(payload) });

export const apiDeactivateUser = (id: number) =>
  apiFetch<void>(`/admin/users/${id}`, { method: 'DELETE' });

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

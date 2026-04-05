'use client';
// src/lib/auth-context.tsx
// Global auth state via React context.
// Token lives in sessionStorage — cleared on tab close, never in localStorage.

import React, {
  createContext, useContext, useState, useEffect, useCallback, ReactNode,
} from 'react';
import { useRouter, usePathname } from 'next/navigation';
import {
  apiAdminLogin, getToken, setToken, clearToken, TokenResponse,
} from './api';

interface AuthContextValue {
  isAuthenticated: boolean;
  adminId:         number | null;
  loading:         boolean;
  login:  (username: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [adminId,         setAdminId]         = useState<number | null>(null);
  const [loading,         setLoading]         = useState(true);
  const router   = useRouter();
  const pathname = usePathname();

  // ── Rehydrate from sessionStorage on mount ────────────────────────────
  useEffect(() => {
    const token = getToken();
    if (token) {
      setIsAuthenticated(true);
      // We don't store adminId separately — not needed for admin panel logic.
    }
    setLoading(false);
  }, []);

  // ── Route guard ───────────────────────────────────────────────────────
  useEffect(() => {
    if (loading) return;
    const publicPaths = ['/login'];
    const isPublic    = publicPaths.some((p) => pathname.startsWith(p));
    if (!isAuthenticated && !isPublic) {
      router.replace('/login');
    }
    if (isAuthenticated && isPublic) {
      router.replace('/dashboard');
    }
  }, [isAuthenticated, loading, pathname, router]);

  // ── Login ─────────────────────────────────────────────────────────────
  const login = useCallback(async (username: string, password: string) => {
    const resp: TokenResponse = await apiAdminLogin(username, password);
    if (resp.role !== 'admin') {
      throw new Error('This login is for administrators only.');
    }
    setToken(resp.access_token);
    setAdminId(resp.user_id);
    setIsAuthenticated(true);
    router.push('/dashboard');
  }, [router]);

  // ── Logout ────────────────────────────────────────────────────────────
  const logout = useCallback(() => {
    clearToken();
    setIsAuthenticated(false);
    setAdminId(null);
    router.push('/login');
  }, [router]);

  return (
    <AuthContext.Provider value={{ isAuthenticated, adminId, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

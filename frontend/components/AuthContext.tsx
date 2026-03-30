'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';

const BACKEND = '';

export interface AuthUser {
  id: string;
  username: string;
  isAdmin?: boolean;
  createdAt: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  login: (username: string, password: string, create?: boolean) => Promise<{ exists?: boolean; error?: string }>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  token: null,
  loading: true,
  login: async () => ({}),
  logout: () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore session from localStorage on mount
  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('lethe_token') : null;
    if (stored) {
      fetch(`${BACKEND}/api/v1/auth/me`, {
        headers: { Authorization: `Bearer ${stored}` },
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (data?.user) {
            setUser(data.user);
            setToken(stored);
          } else {
            localStorage.removeItem('lethe_token');
          }
        })
        .catch(() => localStorage.removeItem('lethe_token'))
        .finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
  }, []);

  const login = useCallback(async (username: string, password: string, create = false) => {
    const res = await fetch(`${BACKEND}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, create }),
    });
    const data = await res.json();
    if (!res.ok) return { error: data.error ?? 'Login failed' };
    if (data.exists === false) return { exists: false };
    localStorage.setItem('lethe_token', data.token);
    setToken(data.token);
    setUser(data.user);
    return {};
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('lethe_token');
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

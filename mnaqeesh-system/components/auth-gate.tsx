'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { describeAccess, type ClientAccess, type SessionUser } from '@/lib/client/session';

type AuthContextValue = {
  session: SessionUser | null;
  /** True while the first describeAccess() is still running. */
  loading: boolean;
  /** Set when access is refused, so pages can explain why. */
  blocked: Extract<ClientAccess, { state: 'no_profile' | 'pending' | 'disabled' }> | null;
  refresh: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  session: null,
  loading: true,
  blocked: null,
  refresh: async () => {}
});

/**
 * Client-side auth provider — the static-hosting replacement of the
 * server components' describeAccess() gates. Reads the member's own
 * profile through RLS and shares the result with the whole tree.
 */
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ClientAccess>({ state: 'loading' });
  const [loading, setLoading] = useState(true);

  const refresh = useMemo(
    () => async () => {
      try {
        const access = await describeAccess();
        setState(access);
      } catch {
        // A network failure must not brick the page; the user can retry
        // by reloading. Anonymous is the safe interpretation.
        setState({ state: 'anonymous' });
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value: AuthContextValue = {
    session: state.state === 'active' ? state.session : null,
    loading,
    blocked: state.state === 'no_profile' || state.state === 'pending' || state.state === 'disabled' ? state : null,
    refresh
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}

/**
 * The active session once the gate has passed — for pages rendered under
 * the dashboard layout, which only renders children when access is active.
 */
export function useSession(): SessionUser | null {
  return useContext(AuthContext).session;
}

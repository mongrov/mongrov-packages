import React, { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { AuthClient, AuthClientConfig, AuthState } from './types';
import { createAuthClient } from './auth-client';

interface AuthActions {
  signIn: (credentials: Record<string, unknown>) => Promise<void>;
  signOut: () => Promise<void>;
}

interface AuthContextValue {
  client: AuthClient;
  actions: AuthActions;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider(props: {
  config: AuthClientConfig;
  children: React.ReactNode;
}): JSX.Element {
  const { config, children } = props;

  const client = useMemo(() => createAuthClient(config), []);
  // Stable action references — never change across renders
  const actions = useRef<AuthActions>({
    signIn: client.signIn,
    signOut: client.signOut,
  }).current;

  useEffect(() => {
    client.hydrate();
    return () => client.destroy();
  }, [client]);

  return (
    <AuthContext.Provider value={{ client, actions }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState & AuthActions {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  const state = useSyncExternalStore(
    ctx.client.subscribe,
    ctx.client.getState,
    ctx.client.getState,
  );

  return {
    ...state,
    signIn: ctx.actions.signIn,
    signOut: ctx.actions.signOut,
  };
}

/** @internal Expose client for session/interceptor use */
export function useAuthClient(): AuthClient {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthClient must be used within an AuthProvider');
  }
  return ctx.client;
}

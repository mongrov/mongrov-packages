import type { AuthClient, AuthClientConfig, AuthState } from './types'
import * as React from 'react'
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { createAuthClient } from './auth-client'
import { describeError } from './log'

interface AuthActions {
  signIn: (credentials: Record<string, unknown>) => Promise<void>
  signOut: () => Promise<void>
}

interface AuthContextValue {
  client: AuthClient
  actions: AuthActions
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider(props: {
  config: AuthClientConfig
  children: React.ReactNode
}): JSX.Element {
  const { config, children } = props

  // Config is read once: later changes are not applied to the live client.
  const { client, logger } = useMemo(
    () => ({ client: createAuthClient(config), logger: config.logger }),
    [],
  )
  // Stable action references — never change across renders
  const actions = useRef<AuthActions>({
    signIn: client.signIn,
    signOut: client.signOut,
  }).current

  useEffect(() => {
    // hydrate handles and logs its own failures; this only catches a throw
    // from the machine itself.
    client.hydrate().catch((err: unknown) => {
      logger?.error('[auth] hydrate threw', { error: describeError(err) })
    })
    return () => client.destroy()
  }, [client, logger])

  return (
    <AuthContext.Provider value={{ client, actions }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState & AuthActions {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider')
  }

  const state = useSyncExternalStore(
    ctx.client.subscribe,
    ctx.client.getState,
    ctx.client.getState,
  )

  return {
    ...state,
    signIn: ctx.actions.signIn,
    signOut: ctx.actions.signOut,
  }
}

/** @internal Expose client for session/interceptor use */
export function useAuthClient(): AuthClient {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuthClient must be used within an AuthProvider')
  }
  return ctx.client
}

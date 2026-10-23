import type { AuthMachineContext } from './machines/auth-machine'
import type { RefreshManager } from './refresh-manager'
import type {
  AuthClient,
  AuthClientConfig,
  AuthError,
  AuthErrorCode,
  AuthState,
  AuthStatus,
  AuthTokens,
  TokenStore,
  UserInfo,
} from './types'

import { jwtDecode } from 'jwt-decode'
import { createActor } from 'xstate'
import { describeError, noopLogger } from './log'
import { authMachine } from './machines/auth-machine'
import { createRefreshManager } from './refresh-manager'
import { createSecureTokenStore } from './secure-token-store'

/** Sign-in failures the user caused and can fix: handled, not a defect. */
const EXPECTED_SIGN_IN_CODES: ReadonlySet<AuthErrorCode> = new Set<AuthErrorCode>([
  'INVALID_CREDENTIALS',
  'VALIDATION_ERROR',
  'RATE_LIMITED',
  'ACCOUNT_LOCKED',
  'DUPLICATE_EMAIL',
  'REGISTRATION_DISABLED',
  // Offline or an unreachable server: the user retries, nothing is broken.
  'NETWORK_ERROR',
])

function classifyError(err: unknown): AuthErrorCode {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase()
    // Check for AuthError already classified (e.g. from refresh manager)
    if ('code' in err && typeof (err as AuthError).code === 'string') {
      return (err as AuthError).code
    }
    if (msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused')) {
      return 'NETWORK_ERROR'
    }
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid credentials')) {
      return 'INVALID_CREDENTIALS'
    }
    if (msg.includes('expired')) {
      return 'TOKEN_EXPIRED'
    }
  }
  return 'ADAPTER_ERROR'
}

function defaultParseUser(decoded: Record<string, unknown>): UserInfo {
  return {
    id: String(decoded.sub ?? decoded.id ?? ''),
    email: decoded.email as string | undefined,
    name: decoded.name as string | undefined,
    roles: decoded.roles as string[] | undefined,
  }
}

/** Map XState machine state to public AuthStatus */
function mapStatus(stateValue: string): AuthStatus {
  switch (stateValue) {
    case 'idle': return 'idle'
    case 'authenticating': return 'authenticating'
    case 'authenticated': return 'authenticated'
    case 'error': return 'error'
    default: return 'idle'
  }
}

/** Derive public AuthState from machine context + state value */
function derivePublicState(stateValue: string, context: AuthMachineContext): AuthState {
  const status = mapStatus(stateValue)
  return {
    status,
    user: context.user,
    error: context.error,
    isAuthenticated: status === 'authenticated',
    isLoading: status === 'authenticating',
    isHydrated: context.isHydrated,
  }
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const {
    adapter,
    proactiveRefresh = true,
    refreshThreshold = 0.8,
    parseUserFromToken = defaultParseUser,
    logger: log = noopLogger,
  } = config
  const tokenStore: TokenStore = config.tokenStore ?? createSecureTokenStore({ logger: log })

  // Create and start the XState actor
  const actor = createActor(authMachine)
  logStatusTransitions()
  actor.start()

  /** One info line per public status change (idle/authenticating/authenticated/error). */
  function logStatusTransitions(): void {
    let lastStatus: AuthStatus = 'idle'
    actor.subscribe((snap) => {
      const status = mapStatus(snap.value as string)
      if (status === lastStatus)
        return
      log.info('[auth] state changed', {
        from: lastStatus,
        to: status,
        ...(snap.context.error ? { errorCode: snap.context.error.code } : {}),
      })
      lastStatus = status
    })
  }

  async function resolveUser(accessToken: string): Promise<UserInfo> {
    if (adapter.getUser) {
      return adapter.getUser(accessToken)
    }
    const decoded = jwtDecode<Record<string, unknown>>(accessToken)
    return parseUserFromToken(decoded)
  }

  function isTokenExpired(accessToken: string): boolean {
    try {
      const decoded = jwtDecode<{ exp?: number }>(accessToken)
      if (!decoded.exp)
        return false
      return decoded.exp * 1000 < Date.now()
    }
    catch (err) {
      // Handled: an undecodable token is treated as expired and refreshed.
      log.warn('[auth] access token not decodable; treating as expired', { error: describeError(err) })
      return true
    }
  }

  const refreshManager: RefreshManager = createRefreshManager({
    adapter,
    tokenStore,
    proactiveRefresh,
    refreshThreshold,
    logger: log,
    onRefreshed: (tokens: AuthTokens) => {
      log.info('[auth] token refresh succeeded', { rotatedRefreshToken: Boolean(tokens.refreshToken) })
      const snap = actor.getSnapshot()
      actor.send({
        type: 'TOKEN_REFRESHED',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? snap.context.refreshToken,
      })
    },
    onRefreshFailed: (error: AuthError) => {
      log.error('[auth] token refresh failed, signing out', { error: describeError(error) })
      // clear() is async but callback is sync — chain to ensure tokens
      // are removed before any subsequent hydrate can read stale values.
      tokenStore.clear().then(
        () => actor.send({ type: 'REFRESH_FAILED' }),
        (clearErr: unknown) => {
          log.error('[auth] token store clear failed after refresh failure', { error: describeError(clearErr) })
          actor.send({ type: 'REFRESH_FAILED' })
        },
      )
    },
  })

  async function signIn(credentials: Record<string, unknown>): Promise<void> {
    log.info('[auth] signIn started')
    actor.send({ type: 'SIGN_IN' })
    try {
      const tokens = await adapter.login(credentials)
      await tokenStore.setAccessToken(tokens.accessToken)
      if (tokens.refreshToken) {
        await tokenStore.setRefreshToken(tokens.refreshToken)
      }
      const user = await resolveUser(tokens.accessToken)
      actor.send({
        type: 'SIGN_IN_SUCCESS',
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
      })
      log.info('[auth] signIn succeeded')
      if (proactiveRefresh && tokens.expiresIn) {
        refreshManager.scheduleRefresh(tokens.expiresIn)
      }
    }
    catch (err) {
      const authError: AuthError = {
        code: classifyError(err),
        message: err instanceof Error ? err.message : 'Sign in failed',
        original: err instanceof Error ? err : undefined,
      }
      const level = EXPECTED_SIGN_IN_CODES.has(authError.code) ? 'warn' : 'error'
      log[level]('[auth] signIn failed', { code: authError.code, error: describeError(err) })
      actor.send({ type: 'SIGN_IN_FAILURE', error: authError })
      throw authError
    }
  }

  async function signOut(): Promise<void> {
    log.info('[auth] signOut')
    const { accessToken } = actor.getSnapshot().context
    refreshManager.cancelRefresh()
    if (adapter.logout && accessToken) {
      // fire-and-forget: local sign-out proceeds whatever the server says
      adapter.logout(accessToken).catch((err: unknown) => {
        log.warn('[auth] server logout failed; signed out locally', { error: describeError(err) })
      })
    }
    await tokenStore.clear()
    actor.send({ type: 'SIGN_OUT' })
  }

  async function hydrate(): Promise<void> {
    log.debug('[auth] hydrate started')
    actor.send({ type: 'HYDRATE_START' }) // transitions to authenticating (hydrate flow)
    try {
      const accessToken = await tokenStore.getAccessToken()
      if (!accessToken) {
        log.info('[auth] hydrate: no stored session')
        actor.send({ type: 'HYDRATE_NO_TOKENS' })
        return
      }

      const refreshToken = await tokenStore.getRefreshToken()

      if (isTokenExpired(accessToken)) {
        if (refreshToken) {
          log.info('[auth] hydrate: token expired, refreshing')
          const tokens = await refreshManager.handleUnauthorized()
          const user = await resolveUser(tokens.accessToken)
          actor.send({
            type: 'HYDRATE_SUCCESS',
            user,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? refreshToken,
          })
          log.info('[auth] hydrate: refreshed and restored session')
        }
        else {
          log.info('[auth] hydrate: token expired and no refresh token; signed out')
          await tokenStore.clear()
          actor.send({ type: 'HYDRATE_NO_TOKENS' })
        }
        return
      }

      const user = await resolveUser(accessToken)
      actor.send({
        type: 'HYDRATE_SUCCESS',
        user,
        accessToken,
        refreshToken,
      })
      log.info('[auth] hydrate: restored session')

      // Try to get expiresIn from token for scheduling
      try {
        const decoded = jwtDecode<{ exp?: number }>(accessToken)
        if (decoded.exp && proactiveRefresh) {
          const remainingSec = decoded.exp - Math.floor(Date.now() / 1000)
          if (remainingSec > 0) {
            refreshManager.scheduleRefresh(remainingSec)
          }
        }
      }
      catch {
        // expected: isTokenExpired already decoded this token (and warned if
        // it could not), so this only skips proactive refresh
      }
    }
    catch (err) {
      // If refresh failed, onRefreshFailed already logged it and handled the
      // transition back to idle.
      const snap = actor.getSnapshot()
      if (snap.value !== 'idle') {
        log.error('[auth] hydrate failed', { error: describeError(err) })
        const authError: AuthError = {
          code: 'ADAPTER_ERROR',
          message: err instanceof Error ? err.message : 'Hydration failed',
          original: err instanceof Error ? err : undefined,
        }
        actor.send({ type: 'HYDRATE_FAILURE', error: authError })
      }
    }
    finally {
      actor.send({ type: 'SET_HYDRATED' })
    }
  }

  // Cache the public state snapshot for useSyncExternalStore compatibility.
  // Must return the same reference when public fields haven't changed
  // (e.g. silent token refresh only updates tokens in context).
  let cachedPublicState: AuthState = derivePublicState('idle', authMachine.config.context as AuthMachineContext)

  function shallowEqual(a: AuthState, b: AuthState): boolean {
    return (
      a.status === b.status
      && a.user === b.user
      && a.error === b.error
      && a.isAuthenticated === b.isAuthenticated
      && a.isLoading === b.isLoading
      && a.isHydrated === b.isHydrated
    )
  }

  function getState(): AuthState {
    const snap = actor.getSnapshot()
    const publicState = derivePublicState(snap.value as string, snap.context)
    if (shallowEqual(publicState, cachedPublicState)) {
      return cachedPublicState
    }
    cachedPublicState = publicState
    return cachedPublicState
  }

  function subscribe(listener: (state: AuthState) => void): () => void {
    // Each listener tracks the last state IT was given. Comparing against the
    // shared cache notified only the first listener per transition: its
    // getState() call replaced the cache, so every later listener saw
    // prev === next and was never told (e.g. AnalyticsSuite missing sign-in).
    let last = getState()
    const sub = actor.subscribe(() => {
      const next = getState()
      if (next !== last) {
        last = next
        listener(next)
      }
    })
    return () => sub.unsubscribe()
  }

  function getAccessToken(): string | null {
    return actor.getSnapshot().context.accessToken
  }

  function getRefreshToken(): string | null {
    return actor.getSnapshot().context.refreshToken
  }

  function refreshTokenFn(): Promise<AuthTokens> {
    return refreshManager.handleUnauthorized()
  }

  function destroy(): void {
    refreshManager.destroy()
    actor.stop()
  }

  return {
    getState,
    subscribe,
    signIn,
    signOut,
    hydrate,
    getAccessToken,
    getRefreshToken,
    refreshToken: refreshTokenFn,
    destroy,
  }
}

import { createActor } from 'xstate';
import { jwtDecode } from 'jwt-decode';
import type {
  AuthClient,
  AuthClientConfig,
  AuthError,
  AuthErrorCode,
  AuthLogger,
  AuthState,
  AuthStatus,
  AuthTokens,
  TokenStore,
  UserInfo,
} from './types';

import { SecureTokenStore } from './secure-token-store';
import { createRefreshManager } from './refresh-manager';
import type { RefreshManager } from './refresh-manager';
import { authMachine } from './machines/auth-machine';
import type { AuthMachineContext } from './machines/auth-machine';

const noopLogger: AuthLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function classifyError(err: unknown): AuthErrorCode {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    // Check for AuthError already classified (e.g. from refresh manager)
    if ('code' in err && typeof (err as AuthError).code === 'string') {
      return (err as AuthError).code;
    }
    if (msg.includes('network') || msg.includes('timeout') || msg.includes('econnrefused')) {
      return 'NETWORK_ERROR';
    }
    if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid credentials')) {
      return 'INVALID_CREDENTIALS';
    }
    if (msg.includes('expired')) {
      return 'TOKEN_EXPIRED';
    }
  }
  return 'ADAPTER_ERROR';
}

function defaultParseUser(decoded: Record<string, unknown>): UserInfo {
  return {
    id: String(decoded.sub ?? decoded.id ?? ''),
    email: decoded.email as string | undefined,
    name: decoded.name as string | undefined,
    roles: decoded.roles as string[] | undefined,
  };
}

/** Map XState machine state to public AuthStatus */
function mapStatus(stateValue: string): AuthStatus {
  switch (stateValue) {
    case 'idle': return 'idle';
    case 'authenticating': return 'authenticating';
    case 'authenticated': return 'authenticated';
    case 'error': return 'error';
    default: return 'idle';
  }
}

/** Derive public AuthState from machine context + state value */
function derivePublicState(stateValue: string, context: AuthMachineContext): AuthState {
  const status = mapStatus(stateValue);
  return {
    status,
    user: context.user,
    error: context.error,
    isAuthenticated: status === 'authenticated',
    isLoading: status === 'authenticating',
    isHydrated: context.isHydrated,
  };
}

export function createAuthClient(config: AuthClientConfig): AuthClient {
  const {
    adapter,
    tokenStore = SecureTokenStore as TokenStore,
    proactiveRefresh = true,
    refreshThreshold = 0.8,
    parseUserFromToken = defaultParseUser,
    logger: log = noopLogger,
  } = config;

  // Create and start the XState actor
  const actor = createActor(authMachine);
  actor.start();

  async function resolveUser(accessToken: string): Promise<UserInfo> {
    if (adapter.getUser) {
      return adapter.getUser(accessToken);
    }
    const decoded = jwtDecode<Record<string, unknown>>(accessToken);
    return parseUserFromToken(decoded);
  }

  function isTokenExpired(accessToken: string): boolean {
    try {
      const decoded = jwtDecode<{ exp?: number }>(accessToken);
      if (!decoded.exp) return false;
      return decoded.exp * 1000 < Date.now();
    } catch {
      return true;
    }
  }

  const refreshManager: RefreshManager = createRefreshManager({
    adapter,
    tokenStore,
    proactiveRefresh,
    refreshThreshold,
    onRefreshed: (tokens: AuthTokens) => {
      log.debug('[auth] token refreshed silently');
      const snap = actor.getSnapshot();
      actor.send({
        type: 'TOKEN_REFRESHED',
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? snap.context.refreshToken,
      });
    },
    onRefreshFailed: (error: AuthError) => {
      log.warn('[auth] token refresh failed, signing out', error.message);
      // clear() is async but callback is sync — chain to ensure tokens
      // are removed before any subsequent hydrate can read stale values.
      tokenStore.clear().then(
        () => actor.send({ type: 'REFRESH_FAILED' }),
        () => actor.send({ type: 'REFRESH_FAILED' }),
      );
    },
  });

  async function signIn(credentials: Record<string, unknown>): Promise<void> {
    log.info('[auth] signIn started');
    actor.send({ type: 'SIGN_IN' });
    try {
      const tokens = await adapter.login(credentials);
      await tokenStore.setAccessToken(tokens.accessToken);
      if (tokens.refreshToken) {
        await tokenStore.setRefreshToken(tokens.refreshToken);
      }
      const user = await resolveUser(tokens.accessToken);
      actor.send({
        type: 'SIGN_IN_SUCCESS',
        user,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? null,
      });
      log.info('[auth] signIn succeeded', user.id);
      if (proactiveRefresh && tokens.expiresIn) {
        refreshManager.scheduleRefresh(tokens.expiresIn);
      }
    } catch (err) {
      const authError: AuthError = {
        code: classifyError(err),
        message: err instanceof Error ? err.message : 'Sign in failed',
        original: err instanceof Error ? err : undefined,
      };
      log.error('[auth] signIn failed', authError.code, authError.message);
      actor.send({ type: 'SIGN_IN_FAILURE', error: authError });
      throw authError;
    }
  }

  async function signOut(): Promise<void> {
    log.info('[auth] signOut');
    const { accessToken } = actor.getSnapshot().context;
    refreshManager.cancelRefresh();
    if (adapter.logout && accessToken) {
      // fire-and-forget
      adapter.logout(accessToken).catch(() => {});
    }
    await tokenStore.clear();
    actor.send({ type: 'SIGN_OUT' });
  }

  async function hydrate(): Promise<void> {
    log.debug('[auth] hydrate started');
    actor.send({ type: 'HYDRATE_START' }); // transitions to authenticating (hydrate flow)
    try {
      const accessToken = await tokenStore.getAccessToken();
      if (!accessToken) {
        log.debug('[auth] hydrate: no stored tokens, staying idle');
        actor.send({ type: 'HYDRATE_NO_TOKENS' });
        return;
      }

      const refreshToken = await tokenStore.getRefreshToken();

      if (isTokenExpired(accessToken)) {
        if (refreshToken) {
          log.debug('[auth] hydrate: token expired, attempting refresh');
          const tokens = await refreshManager.handleUnauthorized();
          const user = await resolveUser(tokens.accessToken);
          actor.send({
            type: 'HYDRATE_SUCCESS',
            user,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken ?? refreshToken,
          });
          log.info('[auth] hydrate: refreshed and restored session', user.id);
        } else {
          log.debug('[auth] hydrate: token expired, no refresh token');
          await tokenStore.clear();
          actor.send({ type: 'HYDRATE_NO_TOKENS' });
        }
        return;
      }

      const user = await resolveUser(accessToken);
      actor.send({
        type: 'HYDRATE_SUCCESS',
        user,
        accessToken,
        refreshToken,
      });
      log.info('[auth] hydrate: restored session', user.id);

      // Try to get expiresIn from token for scheduling
      try {
        const decoded = jwtDecode<{ exp?: number }>(accessToken);
        if (decoded.exp && proactiveRefresh) {
          const remainingSec = decoded.exp - Math.floor(Date.now() / 1000);
          if (remainingSec > 0) {
            refreshManager.scheduleRefresh(remainingSec);
          }
        }
      } catch {
        // Can't decode exp — no proactive refresh
      }
    } catch (err) {
      // If refresh failed, onRefreshFailed already handled transition
      const snap = actor.getSnapshot();
      if (snap.value !== 'idle') {
        const authError: AuthError = {
          code: 'ADAPTER_ERROR',
          message: err instanceof Error ? err.message : 'Hydration failed',
          original: err instanceof Error ? err : undefined,
        };
        actor.send({ type: 'HYDRATE_FAILURE', error: authError });
      }
    } finally {
      actor.send({ type: 'SET_HYDRATED' });
    }
  }

  // Cache the public state snapshot for useSyncExternalStore compatibility.
  // Must return the same reference when public fields haven't changed
  // (e.g. silent token refresh only updates tokens in context).
  let cachedPublicState: AuthState = derivePublicState('idle', authMachine.config.context as AuthMachineContext);

  function shallowEqual(a: AuthState, b: AuthState): boolean {
    return (
      a.status === b.status &&
      a.user === b.user &&
      a.error === b.error &&
      a.isAuthenticated === b.isAuthenticated &&
      a.isLoading === b.isLoading &&
      a.isHydrated === b.isHydrated
    );
  }

  function getState(): AuthState {
    const snap = actor.getSnapshot();
    const publicState = derivePublicState(snap.value as string, snap.context);
    if (shallowEqual(publicState, cachedPublicState)) {
      return cachedPublicState;
    }
    cachedPublicState = publicState;
    return cachedPublicState;
  }

  function subscribe(listener: (state: AuthState) => void): () => void {
    const sub = actor.subscribe(() => {
      const prev = cachedPublicState;
      const next = getState();
      if (prev !== next) {
        listener(next);
      }
    });
    return () => sub.unsubscribe();
  }

  function getAccessToken(): string | null {
    return actor.getSnapshot().context.accessToken;
  }

  function getRefreshToken(): string | null {
    return actor.getSnapshot().context.refreshToken;
  }

  function refreshTokenFn(): Promise<AuthTokens> {
    return refreshManager.handleUnauthorized();
  }

  function destroy(): void {
    refreshManager.destroy();
    actor.stop();
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
  };
}

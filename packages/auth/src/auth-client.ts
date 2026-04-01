import { createStore } from 'zustand/vanilla';
import { jwtDecode } from 'jwt-decode';
import type {
  AuthClient,
  AuthClientConfig,
  AuthError,
  AuthErrorCode,
  AuthLogger,
  AuthState,
  AuthTokens,
  TokenStore,
  UserInfo,
} from './types';

import { SecureTokenStore } from './secure-token-store';
import { createRefreshManager } from './refresh-manager';
import type { RefreshManager } from './refresh-manager';

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

interface InternalState extends AuthState {
  _accessToken: string | null;
  _refreshToken: string | null;
}

function defaultParseUser(decoded: Record<string, unknown>): UserInfo {
  return {
    id: String(decoded.sub ?? decoded.id ?? ''),
    email: decoded.email as string | undefined,
    name: decoded.name as string | undefined,
    roles: decoded.roles as string[] | undefined,
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

  const store = createStore<InternalState>(() => ({
    status: 'idle',
    user: null,
    error: null,
    isAuthenticated: false,
    isLoading: false,
    isHydrated: false,
    _accessToken: null,
    _refreshToken: null,
  }));

  function setAuthenticated(user: UserInfo, accessToken: string, refreshToken: string | null): void {
    store.setState((prev) => ({
      status: 'authenticated' as const,
      user,
      error: null,
      isAuthenticated: true,
      isLoading: false,
      isHydrated: prev.isHydrated,
      _accessToken: accessToken,
      _refreshToken: refreshToken,
    }));
  }

  function setIdle(): void {
    store.setState((prev) => ({
      status: 'idle' as const,
      user: null,
      error: null,
      isAuthenticated: false,
      isLoading: false,
      isHydrated: prev.isHydrated,
      _accessToken: null,
      _refreshToken: null,
    }));
  }

  function setAuthenticating(): void {
    store.setState((prev) => ({
      status: 'authenticating' as const,
      user: null,
      error: null,
      isAuthenticated: false,
      isLoading: true,
      isHydrated: prev.isHydrated,
      _accessToken: null,
      _refreshToken: null,
    }));
  }

  function setError(error: AuthError): void {
    store.setState((prev) => ({
      status: 'error' as const,
      error,
      isAuthenticated: false,
      isLoading: false,
      isHydrated: prev.isHydrated,
      _accessToken: null,
      _refreshToken: null,
    }));
  }

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
      const state = store.getState();
      store.setState({
        _accessToken: tokens.accessToken,
        _refreshToken: tokens.refreshToken ?? state._refreshToken,
      });
    },
    onRefreshFailed: (error: AuthError) => {
      log.warn('[auth] token refresh failed, signing out', error.message);
      // clear() is async but callback is sync — chain to ensure tokens
      // are removed before any subsequent hydrate can read stale values.
      tokenStore.clear().then(() => setIdle(), () => setIdle());
    },
  });

  async function signIn(credentials: Record<string, unknown>): Promise<void> {
    log.info('[auth] signIn started');
    setAuthenticating();
    try {
      const tokens = await adapter.login(credentials);
      await tokenStore.setAccessToken(tokens.accessToken);
      if (tokens.refreshToken) {
        await tokenStore.setRefreshToken(tokens.refreshToken);
      }
      const user = await resolveUser(tokens.accessToken);
      setAuthenticated(user, tokens.accessToken, tokens.refreshToken ?? null);
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
      setError(authError);
      throw authError;
    }
  }

  async function signOut(): Promise<void> {
    log.info('[auth] signOut');
    const { _accessToken } = store.getState();
    refreshManager.cancelRefresh();
    if (adapter.logout && _accessToken) {
      // fire-and-forget
      adapter.logout(_accessToken).catch(() => {});
    }
    await tokenStore.clear();
    setIdle();
  }

  async function hydrate(): Promise<void> {
    log.debug('[auth] hydrate started');
    setAuthenticating();
    try {
      const accessToken = await tokenStore.getAccessToken();
      if (!accessToken) {
        log.debug('[auth] hydrate: no stored tokens, staying idle');
        setIdle();
        return;
      }

      const refreshToken = await tokenStore.getRefreshToken();

      if (isTokenExpired(accessToken)) {
        if (refreshToken) {
          log.debug('[auth] hydrate: token expired, attempting refresh');
          const tokens = await refreshManager.handleUnauthorized();
          const user = await resolveUser(tokens.accessToken);
          setAuthenticated(user, tokens.accessToken, tokens.refreshToken ?? refreshToken);
          log.info('[auth] hydrate: refreshed and restored session', user.id);
          // Note: scheduleRefresh is called inside doRefresh() after successful refresh,
          // so we don't need to call it again here.
        } else {
          log.debug('[auth] hydrate: token expired, no refresh token');
          await tokenStore.clear();
          setIdle();
        }
        return;
      }

      const user = await resolveUser(accessToken);
      setAuthenticated(user, accessToken, refreshToken);
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
      // If refresh failed, onRefreshFailed already set idle
      // For other errors, set error state
      if (store.getState().status !== 'idle') {
        const authError: AuthError = {
          code: 'ADAPTER_ERROR',
          message: err instanceof Error ? err.message : 'Hydration failed',
          original: err instanceof Error ? err : undefined,
        };
        setError(authError);
      }
    } finally {
      store.setState({ isHydrated: true });
    }
  }

  // Cache the public state snapshot for useSyncExternalStore compatibility.
  // Must return the same reference when public fields haven't changed
  // (e.g. silent token refresh only updates _accessToken/_refreshToken).
  let cachedPublicState: AuthState = {
    status: 'idle',
    user: null,
    error: null,
    isAuthenticated: false,
    isLoading: false,
    isHydrated: false,
  };

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
    const { _accessToken, _refreshToken, ...publicState } = store.getState();
    if (shallowEqual(publicState, cachedPublicState)) {
      return cachedPublicState;
    }
    cachedPublicState = publicState;
    return cachedPublicState;
  }

  function subscribe(listener: (state: AuthState) => void): () => void {
    return store.subscribe(() => {
      const prev = cachedPublicState;
      const next = getState();
      // Only notify when public state actually changed
      if (prev !== next) {
        listener(next);
      }
    });
  }

  function getAccessToken(): string | null {
    return store.getState()._accessToken;
  }

  function getRefreshToken(): string | null {
    return store.getState()._refreshToken;
  }

  function refreshTokenFn(): Promise<AuthTokens> {
    return refreshManager.handleUnauthorized();
  }

  function destroy(): void {
    refreshManager.destroy();
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

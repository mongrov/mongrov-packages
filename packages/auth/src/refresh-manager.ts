import type { AuthAdapter, AuthError, AuthTokens, TokenStore } from './types';

export interface RefreshManagerConfig {
  adapter: AuthAdapter;
  tokenStore: TokenStore;
  onRefreshed: (tokens: AuthTokens) => void;
  onRefreshFailed: (error: AuthError) => void;
  proactiveRefresh: boolean;
  refreshThreshold: number;
}

export interface RefreshManager {
  scheduleRefresh(expiresIn: number): void;
  handleUnauthorized(): Promise<AuthTokens>;
  cancelRefresh(): void;
  destroy(): void;
}

export function createRefreshManager(config: RefreshManagerConfig): RefreshManager {
  const { adapter, tokenStore, onRefreshed, onRefreshFailed, proactiveRefresh, refreshThreshold } = config;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<AuthTokens> | null = null;

  async function doRefresh(): Promise<AuthTokens> {
    const refreshToken = await tokenStore.getRefreshToken();
    if (!refreshToken) {
      const error: AuthError = {
        code: 'REFRESH_FAILED',
        message: 'No refresh token available',
      };
      onRefreshFailed(error);
      throw error;
    }

    try {
      const tokens = await adapter.refresh(refreshToken);
      await tokenStore.setAccessToken(tokens.accessToken);
      if (tokens.refreshToken) {
        await tokenStore.setRefreshToken(tokens.refreshToken);
      }
      onRefreshed(tokens);
      if (proactiveRefresh && tokens.expiresIn) {
        scheduleRefresh(tokens.expiresIn);
      }
      return tokens;
    } catch (err) {
      const error: AuthError = {
        code: 'REFRESH_FAILED',
        message: err instanceof Error ? err.message : 'Token refresh failed',
        original: err instanceof Error ? err : undefined,
      };
      onRefreshFailed(error);
      throw error;
    }
  }

  function scheduleRefresh(expiresIn: number): void {
    cancelRefresh();
    if (!proactiveRefresh || expiresIn <= 0) return;
    const delayMs = expiresIn * refreshThreshold * 1000;
    timer = setTimeout(() => {
      handleUnauthorized().catch(() => {
        // Error already handled via onRefreshFailed callback
      });
    }, delayMs);
  }

  function handleUnauthorized(): Promise<AuthTokens> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  function cancelRefresh(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function destroy(): void {
    cancelRefresh();
    refreshPromise = null;
  }

  return {
    scheduleRefresh,
    handleUnauthorized,
    cancelRefresh,
    destroy,
  };
}

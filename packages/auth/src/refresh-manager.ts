import type { AuthAdapter, AuthError, AuthTokens, TokenStore } from './types'

export interface RefreshManagerConfig {
  adapter: AuthAdapter
  tokenStore: TokenStore
  onRefreshed: (tokens: AuthTokens) => void
  onRefreshFailed: (error: AuthError) => void
  proactiveRefresh: boolean
  refreshThreshold: number
}

export interface RefreshManager {
  scheduleRefresh: (expiresIn: number) => void
  handleUnauthorized: () => Promise<AuthTokens>
  cancelRefresh: () => void
  destroy: () => void
}

export function createRefreshManager(config: RefreshManagerConfig): RefreshManager {
  const { adapter, tokenStore, onRefreshed, onRefreshFailed, proactiveRefresh, refreshThreshold } = config

  let timer: ReturnType<typeof setTimeout> | null = null
  let refreshPromise: Promise<AuthTokens> | null = null
  /**
   * Session generation. Bumped by `cancelRefresh` (which sign-out calls) and
   * by `destroy`, and compared after every await inside `doRefresh`.
   *
   * Cancelling used to clear the timer and nothing else, so a refresh already
   * awaiting `adapter.refresh()` survived sign-out: when it resolved it wrote
   * both tokens and fired `onRefreshed`, repopulating credentials that
   * `tokenStore.clear()` had just removed. If another account signed in
   * meanwhile, the stale refresh overwrote ITS session instead
   * (2026-09-26 review, finding 6).
   */
  let generation = 0

  /** Timer only — does NOT invalidate an in-flight refresh. See `cancelRefresh`. */
  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  /**
   * True while the refresh that captured `gen` is still the current session's.
   * Checked after every await: each one is a point where sign-out can happen.
   */
  function isCurrent(gen: number): boolean {
    return gen === generation
  }

  async function doRefresh(gen: number): Promise<AuthTokens> {
    const refreshToken = await tokenStore.getRefreshToken()
    if (!isCurrent(gen))
      throw abandoned()
    if (!refreshToken) {
      const error: AuthError = {
        code: 'REFRESH_FAILED',
        message: 'No refresh token available',
      }
      onRefreshFailed(error)
      throw error
    }

    try {
      const tokens = await adapter.refresh(refreshToken)
      // The adapter round-trip is the long one, and the window sign-out
      // actually lands in. Nothing below may run for an ended session: these
      // writes are what survived logout.
      if (!isCurrent(gen))
        throw abandoned()
      await tokenStore.setAccessToken(tokens.accessToken)
      if (tokens.refreshToken) {
        await tokenStore.setRefreshToken(tokens.refreshToken)
      }
      if (!isCurrent(gen))
        throw abandoned()
      onRefreshed(tokens)
      if (proactiveRefresh && tokens.expiresIn) {
        scheduleRefresh(tokens.expiresIn)
      }
      return tokens
    }
    catch (err) {
      if (isAbandoned(err))
        throw err
      const error: AuthError = {
        code: 'REFRESH_FAILED',
        message: err instanceof Error ? err.message : 'Token refresh failed',
        original: err instanceof Error ? err : undefined,
      }
      // A stale refresh must not report failure either: `onRefreshFailed`
      // tears down the CURRENT session, so a dead refresh failing would sign
      // out the account that replaced it.
      if (!isCurrent(gen))
        throw abandoned()
      onRefreshFailed(error)
      throw error
    }
  }

  /**
   * The rejection a refresh belonging to an ended session produces. It writes
   * nothing and fires no callback; the caller is already signed out, or is a
   * different session that this one must not speak for.
   */
  function abandoned(): AuthError {
    return {
      code: 'REFRESH_FAILED',
      message: 'Token refresh abandoned: the session ended before it completed',
    }
  }

  function isAbandoned(err: unknown): boolean {
    return typeof err === 'object'
      && err !== null
      && (err as AuthError).message === abandoned().message
  }

  function scheduleRefresh(expiresIn: number): void {
    // `clearTimer`, not `cancelRefresh`: re-arming the timer after a
    // successful refresh must not invalidate the session it just refreshed.
    clearTimer()
    if (!proactiveRefresh || expiresIn <= 0)
      return
    const delayMs = expiresIn * refreshThreshold * 1000
    timer = setTimeout(() => {
      handleUnauthorized().catch(() => {
        // Error already handled via onRefreshFailed callback
      })
    }, delayMs)
  }

  function handleUnauthorized(): Promise<AuthTokens> {
    if (refreshPromise)
      return refreshPromise
    const gen = generation
    refreshPromise = doRefresh(gen).finally(() => {
      // Only the in-flight refresh for the CURRENT generation owns this slot;
      // a stale one settling later must not clear a newer session's promise.
      if (isCurrent(gen))
        refreshPromise = null
    })
    return refreshPromise
  }

  /**
   * Cancel refreshing for this session: drop the timer AND invalidate any
   * refresh already in flight. Sign-out calls this before clearing the store.
   */
  function cancelRefresh(): void {
    clearTimer()
    generation += 1
    refreshPromise = null
  }

  function destroy(): void {
    cancelRefresh()
  }

  return {
    scheduleRefresh,
    handleUnauthorized,
    cancelRefresh,
    destroy,
  }
}

import type { AuthAdapter } from '../types'
import { __resetSecureStore } from '../../__mocks__/expo-secure-store'
import { createRefreshManager } from '../refresh-manager'
import { __resetStoreModules, SecureTokenStore } from '../secure-token-store'

jest.useFakeTimers()

function createMockAdapter(overrides?: Partial<AuthAdapter>): AuthAdapter {
  return {
    login: jest.fn(),
    refresh: jest.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
    })),
    ...overrides,
  }
}

beforeEach(() => {
  __resetStoreModules()
  __resetSecureStore()
})

describe('RefreshManager', () => {
  it('schedules proactive refresh at threshold', async () => {
    const adapter = createMockAdapter()
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('refresh-token')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    })

    manager.scheduleRefresh(100) // 100s → fires at 80s (80000ms)

    // Not yet fired
    jest.advanceTimersByTime(79999)
    expect(adapter.refresh).not.toHaveBeenCalled()

    // Now fires
    jest.advanceTimersByTime(1)

    // Flush microtask queue thoroughly (async chain in doRefresh)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }

    expect(adapter.refresh).toHaveBeenCalledWith('refresh-token')
  })

  it('single-flight guard deduplicates concurrent refresh calls', async () => {
    const adapter = createMockAdapter()
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('refresh-token')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    // Call handleUnauthorized twice concurrently
    const p1 = manager.handleUnauthorized()
    const p2 = manager.handleUnauthorized()

    const [r1, r2] = await Promise.all([p1, p2])

    // Only one call to adapter.refresh
    expect(adapter.refresh).toHaveBeenCalledTimes(1)
    expect(r1).toEqual(r2)
  })

  it('calls onRefreshFailed when refresh fails', async () => {
    const adapter = createMockAdapter({
      refresh: jest.fn().mockRejectedValue(new Error('Network error')),
    })
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('refresh-token')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    await expect(manager.handleUnauthorized()).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
    })

    expect(onRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REFRESH_FAILED', message: 'Network error' }),
    )
  })

  it('fails when no refresh token available', async () => {
    const adapter = createMockAdapter()
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    await expect(manager.handleUnauthorized()).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
      message: 'No refresh token available',
    })
  })

  it('cancelRefresh clears timer', async () => {
    const adapter = createMockAdapter()
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('refresh-token')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    })

    manager.scheduleRefresh(100)
    manager.cancelRefresh()

    jest.advanceTimersByTime(100000)
    expect(adapter.refresh).not.toHaveBeenCalled()
  })

  it('stores new tokens after successful refresh', async () => {
    const adapter = createMockAdapter()
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('old-refresh')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    await manager.handleUnauthorized()

    const newAccess = await SecureTokenStore.getAccessToken()
    const newRefresh = await SecureTokenStore.getRefreshToken()
    expect(newAccess).toBe('new-access')
    expect(newRefresh).toBe('new-refresh')
  })

  it('reschedules after successful proactive refresh', async () => {
    const adapter = createMockAdapter()
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('refresh-token')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    })

    manager.scheduleRefresh(10) // 10s → fires at 8s (8000ms)
    jest.advanceTimersByTime(8000)

    // Flush microtask queue thoroughly
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(adapter.refresh).toHaveBeenCalledTimes(1)

    // Returned expiresIn=3600, so next fire at 3600*0.8=2880s=2880000ms
    jest.advanceTimersByTime(2880000)

    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }

    expect(adapter.refresh).toHaveBeenCalledTimes(2)
  })

  it('destroy clears timer and promise', () => {
    const adapter = createMockAdapter()
    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed: jest.fn(),
      onRefreshFailed: jest.fn(),
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    })

    manager.scheduleRefresh(100)
    manager.destroy()

    jest.advanceTimersByTime(100000)
    expect(adapter.refresh).not.toHaveBeenCalled()
  })

  /**
   * 2026-09-26 review, finding 6 (P1).
   *
   * Sign-out cancels the timer and clears the store, but a refresh already
   * awaiting the adapter used to survive it: on resolve it wrote both tokens
   * and fired `onRefreshed`, so credentials came back after logout and could
   * be hydrated later.
   */
  it('a refresh in flight when the session ends writes nothing and fires nothing', async () => {
    let releaseRefresh: ((t: unknown) => void) | undefined
    const adapter = createMockAdapter({
      refresh: jest.fn(() => new Promise((resolve) => {
        releaseRefresh = resolve
      }) as Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>),
    })
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setAccessToken('old-access')
    await SecureTokenStore.setRefreshToken('old-refresh')

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    // Refresh is in flight and parked inside the adapter.
    const pending = manager.handleUnauthorized()
    await Promise.resolve()

    // Sign-out's sequence: cancel, then clear the store.
    manager.cancelRefresh()
    await SecureTokenStore.clear()

    // The adapter answers afterwards.
    releaseRefresh?.({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 })
    await expect(pending).rejects.toMatchObject({ code: 'REFRESH_FAILED' })

    // The whole point: the store stays empty and nobody is told otherwise.
    expect(await SecureTokenStore.getAccessToken()).toBeNull()
    expect(await SecureTokenStore.getRefreshToken()).toBeNull()
    expect(onRefreshed).not.toHaveBeenCalled()
    // Nor may a dead refresh report failure — that tears down whatever
    // session replaced it.
    expect(onRefreshFailed).not.toHaveBeenCalled()
  })

  it('a refresh abandoned by sign-out cannot fail the session that replaced it', async () => {
    let rejectRefresh: ((e: Error) => void) | undefined
    const adapter = createMockAdapter({
      refresh: jest.fn(() => new Promise((_resolve, reject) => {
        rejectRefresh = reject
      }) as Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>),
    })
    const onRefreshed = jest.fn()
    const onRefreshFailed = jest.fn()

    await SecureTokenStore.setRefreshToken('old-refresh')
    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    const pending = manager.handleUnauthorized()
    await Promise.resolve()
    manager.cancelRefresh()

    rejectRefresh?.(new Error('network died'))
    await expect(pending).rejects.toMatchObject({ code: 'REFRESH_FAILED' })
    expect(onRefreshFailed).not.toHaveBeenCalled()
  })

  it('destroy invalidates an in-flight refresh too', async () => {
    let releaseRefresh: ((t: unknown) => void) | undefined
    const adapter = createMockAdapter({
      refresh: jest.fn(() => new Promise((resolve) => {
        releaseRefresh = resolve
      }) as Promise<{ accessToken: string, refreshToken: string, expiresIn: number }>),
    })
    const onRefreshed = jest.fn()

    await SecureTokenStore.setRefreshToken('old-refresh')
    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed: jest.fn(),
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    })

    const pending = manager.handleUnauthorized()
    await Promise.resolve()
    manager.destroy()

    releaseRefresh?.({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 })
    await expect(pending).rejects.toMatchObject({ code: 'REFRESH_FAILED' })
    expect(onRefreshed).not.toHaveBeenCalled()
    expect(await SecureTokenStore.getAccessToken()).toBeNull()
  })
})

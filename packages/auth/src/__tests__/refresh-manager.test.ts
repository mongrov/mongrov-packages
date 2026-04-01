import type { AuthAdapter, AuthError, AuthTokens } from '../types';
import { createRefreshManager } from '../refresh-manager';
import { SecureTokenStore, __resetStoreModules } from '../secure-token-store';
import { __resetSecureStore } from '../../__mocks__/expo-secure-store';

jest.useFakeTimers();

function createMockAdapter(overrides?: Partial<AuthAdapter>): AuthAdapter {
  return {
    login: jest.fn(),
    refresh: jest.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
    })),
    ...overrides,
  };
}

beforeEach(() => {
  __resetStoreModules();
  __resetSecureStore();
});

describe('RefreshManager', () => {
  it('schedules proactive refresh at threshold', async () => {
    const adapter = createMockAdapter();
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    await SecureTokenStore.setRefreshToken('refresh-token');

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    });

    manager.scheduleRefresh(100); // 100s → fires at 80s (80000ms)

    // Not yet fired
    jest.advanceTimersByTime(79999);
    expect(adapter.refresh).not.toHaveBeenCalled();

    // Now fires
    jest.advanceTimersByTime(1);

    // Flush microtask queue thoroughly (async chain in doRefresh)
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    expect(adapter.refresh).toHaveBeenCalledWith('refresh-token');
  });

  it('single-flight guard deduplicates concurrent refresh calls', async () => {
    const adapter = createMockAdapter();
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    await SecureTokenStore.setRefreshToken('refresh-token');

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    });

    // Call handleUnauthorized twice concurrently
    const p1 = manager.handleUnauthorized();
    const p2 = manager.handleUnauthorized();

    const [r1, r2] = await Promise.all([p1, p2]);

    // Only one call to adapter.refresh
    expect(adapter.refresh).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('calls onRefreshFailed when refresh fails', async () => {
    const adapter = createMockAdapter({
      refresh: jest.fn().mockRejectedValue(new Error('Network error')),
    });
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    await SecureTokenStore.setRefreshToken('refresh-token');

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    });

    await expect(manager.handleUnauthorized()).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
    });

    expect(onRefreshFailed).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'REFRESH_FAILED', message: 'Network error' }),
    );
  });

  it('fails when no refresh token available', async () => {
    const adapter = createMockAdapter();
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    });

    await expect(manager.handleUnauthorized()).rejects.toMatchObject({
      code: 'REFRESH_FAILED',
      message: 'No refresh token available',
    });
  });

  it('cancelRefresh clears timer', async () => {
    const adapter = createMockAdapter();
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    await SecureTokenStore.setRefreshToken('refresh-token');

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    });

    manager.scheduleRefresh(100);
    manager.cancelRefresh();

    jest.advanceTimersByTime(100000);
    expect(adapter.refresh).not.toHaveBeenCalled();
  });

  it('stores new tokens after successful refresh', async () => {
    const adapter = createMockAdapter();
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    await SecureTokenStore.setRefreshToken('old-refresh');

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: false,
      refreshThreshold: 0.8,
    });

    await manager.handleUnauthorized();

    const newAccess = await SecureTokenStore.getAccessToken();
    const newRefresh = await SecureTokenStore.getRefreshToken();
    expect(newAccess).toBe('new-access');
    expect(newRefresh).toBe('new-refresh');
  });

  it('reschedules after successful proactive refresh', async () => {
    const adapter = createMockAdapter();
    const onRefreshed = jest.fn();
    const onRefreshFailed = jest.fn();

    await SecureTokenStore.setRefreshToken('refresh-token');

    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed,
      onRefreshFailed,
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    });

    manager.scheduleRefresh(10); // 10s → fires at 8s (8000ms)
    jest.advanceTimersByTime(8000);

    // Flush microtask queue thoroughly
    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(adapter.refresh).toHaveBeenCalledTimes(1);

    // Returned expiresIn=3600, so next fire at 3600*0.8=2880s=2880000ms
    jest.advanceTimersByTime(2880000);

    for (let i = 0; i < 20; i++) {
      await Promise.resolve();
    }

    expect(adapter.refresh).toHaveBeenCalledTimes(2);
  });

  it('destroy clears timer and promise', () => {
    const adapter = createMockAdapter();
    const manager = createRefreshManager({
      adapter,
      tokenStore: SecureTokenStore,
      onRefreshed: jest.fn(),
      onRefreshFailed: jest.fn(),
      proactiveRefresh: true,
      refreshThreshold: 0.8,
    });

    manager.scheduleRefresh(100);
    manager.destroy();

    jest.advanceTimersByTime(100000);
    expect(adapter.refresh).not.toHaveBeenCalled();
  });
});

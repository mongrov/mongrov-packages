import type { AuthAdapter, AuthState } from '../types';
import { createAuthClient } from '../auth-client';
import { __resetStoreModules } from '../secure-token-store';
import { __resetSecureStore } from '../../__mocks__/expo-secure-store';
import { __setDecoded, __reset as resetJwtDecode } from '../../__mocks__/jwt-decode';

function createMockAdapter(overrides?: Partial<AuthAdapter>): AuthAdapter {
  return {
    login: jest.fn(async () => ({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresIn: 3600,
    })),
    refresh: jest.fn(async () => ({
      accessToken: 'new-access',
      refreshToken: 'new-refresh',
      expiresIn: 3600,
    })),
    logout: jest.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  __resetStoreModules();
  __resetSecureStore();
  resetJwtDecode();
});

describe('createAuthClient', () => {
  it('starts in idle state with isHydrated false', () => {
    const client = createAuthClient({ adapter: createMockAdapter() });
    const state = client.getState();
    expect(state.status).toBe('idle');
    expect(state.isAuthenticated).toBe(false);
    expect(state.isLoading).toBe(false);
    expect(state.isHydrated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.error).toBeNull();
    client.destroy();
  });

  it('transitions to authenticated after successful signIn (isHydrated unchanged)', async () => {
    const adapter = createMockAdapter();
    const client = createAuthClient({ adapter });

    await client.signIn({ username: 'test', password: 'pass' });

    const state = client.getState();
    expect(state.status).toBe('authenticated');
    expect(state.isAuthenticated).toBe(true);
    expect(state.isHydrated).toBe(false); // signIn does not set isHydrated
    expect(state.user).toMatchObject({ id: 'user-1', email: 'test@example.com' });
    expect(adapter.login).toHaveBeenCalledWith({ username: 'test', password: 'pass' });
    client.destroy();
  });

  it('transitions to error after failed signIn', async () => {
    const adapter = createMockAdapter({
      login: jest.fn().mockRejectedValue(new Error('Invalid credentials')),
    });
    const client = createAuthClient({ adapter });

    await expect(client.signIn({ username: 'bad' })).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });

    const state = client.getState();
    expect(state.status).toBe('error');
    expect(state.error?.code).toBe('INVALID_CREDENTIALS');
    expect(state.isAuthenticated).toBe(false);
    client.destroy();
  });

  it('stores tokens after signIn', async () => {
    const client = createAuthClient({ adapter: createMockAdapter() });
    await client.signIn({ username: 'test' });

    expect(client.getAccessToken()).toBe('access-123');
    expect(client.getRefreshToken()).toBe('refresh-456');
    client.destroy();
  });

  it('hydrate with no stored tokens sets idle (not error) and isHydrated true', async () => {
    const client = createAuthClient({ adapter: createMockAdapter() });
    await client.hydrate();

    const state = client.getState();
    expect(state.status).toBe('idle');
    expect(state.isHydrated).toBe(true);
    expect(state.user).toBeNull();
    client.destroy();
  });

  it('hydrate with valid stored tokens sets authenticated', async () => {
    // Pre-store tokens
    const { SecureTokenStore } = require('../secure-token-store');
    await SecureTokenStore.setAccessToken('stored-access');
    await SecureTokenStore.setRefreshToken('stored-refresh');

    // Set jwt-decode to return valid (non-expired) token
    __setDecoded({
      sub: 'user-2',
      email: 'stored@test.com',
      name: 'Stored User',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const client = createAuthClient({ adapter: createMockAdapter() });
    await client.hydrate();

    const state = client.getState();
    expect(state.status).toBe('authenticated');
    expect(state.isHydrated).toBe(true);
    expect(state.user?.id).toBe('user-2');
    client.destroy();
  });

  it('hydrate with expired token and refresh token attempts refresh', async () => {
    const { SecureTokenStore } = require('../secure-token-store');
    await SecureTokenStore.setAccessToken('expired-access');
    await SecureTokenStore.setRefreshToken('old-refresh');

    // Make jwt-decode return expired first call, then valid on subsequent calls
    let callCount = 0;
    const jwtDecodeMock = require('jwt-decode');
    const origJwtDecode = jwtDecodeMock.jwtDecode;
    jwtDecodeMock.jwtDecode = (_token: string) => {
      callCount++;
      if (callCount <= 1) {
        return { sub: 'user-3', email: 'expired@test.com', exp: Math.floor(Date.now() / 1000) - 100 };
      }
      return { sub: 'user-3', email: 'expired@test.com', exp: Math.floor(Date.now() / 1000) + 3600 };
    };

    const adapter = createMockAdapter();
    const client = createAuthClient({ adapter });

    await client.hydrate();

    const state = client.getState();
    expect(state.status).toBe('authenticated');
    expect(adapter.refresh).toHaveBeenCalledWith('old-refresh');

    jwtDecodeMock.jwtDecode = origJwtDecode;
    client.destroy();
  });

  it('signOut clears state and tokens', async () => {
    const adapter = createMockAdapter();
    const client = createAuthClient({ adapter });

    await client.signIn({ username: 'test' });
    expect(client.getState().status).toBe('authenticated');

    await client.signOut();
    expect(client.getState().status).toBe('idle');
    expect(client.getAccessToken()).toBeNull();
    expect(adapter.logout).toHaveBeenCalledWith('access-123');
    client.destroy();
  });

  it('signOut calls adapter.logout (fire-and-forget)', async () => {
    const logoutFn = jest.fn().mockRejectedValue(new Error('logout error'));
    const adapter = createMockAdapter({ logout: logoutFn });
    const client = createAuthClient({ adapter });

    await client.signIn({ username: 'test' });
    await client.signOut();

    // Should not throw despite logout error
    expect(client.getState().status).toBe('idle');
    expect(logoutFn).toHaveBeenCalled();
    client.destroy();
  });

  it('subscribe notifies on state changes', async () => {
    const client = createAuthClient({ adapter: createMockAdapter() });
    const listener = jest.fn();

    client.subscribe(listener);
    await client.signIn({ username: 'test' });

    // At minimum: authenticating + authenticated
    expect(listener).toHaveBeenCalled();
    const lastCall = listener.mock.calls[listener.mock.calls.length - 1][0] as AuthState;
    expect(lastCall.status).toBe('authenticated');
    client.destroy();
  });

  it('can recover from error state with signIn', async () => {
    const callCount = { count: 0 };
    const adapter = createMockAdapter({
      login: jest.fn(async () => {
        callCount.count++;
        if (callCount.count === 1) throw new Error('First fail');
        return { accessToken: 'access-ok', refreshToken: 'refresh-ok', expiresIn: 3600 };
      }),
    });
    const client = createAuthClient({ adapter });

    // First attempt fails
    await expect(client.signIn({ username: 'test' })).rejects.toBeDefined();
    expect(client.getState().status).toBe('error');

    // Second attempt succeeds
    await client.signIn({ username: 'test' });
    expect(client.getState().status).toBe('authenticated');
    client.destroy();
  });
});

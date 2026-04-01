import axios from 'axios';
import { createAuthInterceptor } from '../interceptor';
import type { AuthClient, AuthTokens } from '../types';

function createMockAuthClient(overrides?: Partial<AuthClient>): AuthClient {
  return {
    getState: jest.fn(() => ({
      status: 'authenticated' as const,
      user: { id: 'u1' },
      error: null,
      isAuthenticated: true,
      isLoading: false,
    })),
    subscribe: jest.fn(() => jest.fn()),
    signIn: jest.fn(),
    signOut: jest.fn(),
    hydrate: jest.fn(),
    getAccessToken: jest.fn(() => 'access-token-123'),
    getRefreshToken: jest.fn(() => 'refresh-token-456'),
    refreshToken: jest.fn(async (): Promise<AuthTokens> => ({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 3600,
    })),
    destroy: jest.fn(),
    ...overrides,
  };
}

describe('createAuthInterceptor', () => {
  it('attaches Authorization header to requests', async () => {
    const instance = axios.create();
    const client = createMockAuthClient();

    createAuthInterceptor(instance, client);

    let capturedHeaders: Record<string, string> = {};
    instance.defaults.adapter = async (config) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(config.headers ?? {}).filter(([, v]) => typeof v === 'string'),
      );
      return { status: 200, statusText: 'OK', data: {}, headers: {}, config: config as never };
    };

    await instance.get('/test');

    expect(capturedHeaders['Authorization']).toBe('Bearer access-token-123');
  });

  it('does not attach header when no token', async () => {
    const instance = axios.create();
    const client = createMockAuthClient({ getAccessToken: jest.fn(() => null) });

    createAuthInterceptor(instance, client);

    let capturedHeaders: Record<string, string> = {};
    instance.defaults.adapter = async (config) => {
      capturedHeaders = Object.fromEntries(
        Object.entries(config.headers ?? {}).filter(([, v]) => typeof v === 'string'),
      );
      return { status: 200, statusText: 'OK', data: {}, headers: {}, config: config as never };
    };

    await instance.get('/test');

    expect(capturedHeaders['Authorization']).toBeUndefined();
  });

  it('eject function removes interceptors', () => {
    const instance = axios.create();
    const client = createMockAuthClient();

    const eject = createAuthInterceptor(instance, client);
    eject();
    // Interceptors removed without error
  });

  it('retries on 401 with refreshed token', async () => {
    const instance = axios.create();
    const refreshFn = jest.fn(async (): Promise<AuthTokens> => ({
      accessToken: 'refreshed-access',
      refreshToken: 'refreshed-refresh',
      expiresIn: 3600,
    }));
    const client = createMockAuthClient({ refreshToken: refreshFn });

    createAuthInterceptor(instance, client);

    let callCount = 0;
    instance.defaults.adapter = async (config) => {
      callCount++;
      if (callCount === 1) {
        const error = new axios.AxiosError('Unauthorized', '401', config as never, null, {
          status: 401,
          statusText: 'Unauthorized',
          data: {},
          headers: {},
          config: config as never,
        });
        throw error;
      }
      return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config: config as never };
    };

    const response = await instance.get('/protected');
    expect(response.status).toBe(200);
    expect(refreshFn).toHaveBeenCalled();
  });

  it('calls signOut when refresh fails on 401', async () => {
    const instance = axios.create();
    const signOutFn = jest.fn();
    const client = createMockAuthClient({
      refreshToken: jest.fn().mockRejectedValue(new Error('Refresh failed')),
      signOut: signOutFn,
    });

    createAuthInterceptor(instance, client);

    instance.defaults.adapter = async (config) => {
      const error = new axios.AxiosError('Unauthorized', '401', config as never, null, {
        status: 401,
        statusText: 'Unauthorized',
        data: {},
        headers: {},
        config: config as never,
      });
      throw error;
    };

    await expect(instance.get('/protected')).rejects.toBeDefined();
    expect(signOutFn).toHaveBeenCalled();
  });

  it('does not retry on non-401 errors', async () => {
    const instance = axios.create();
    const refreshFn = jest.fn();
    const client = createMockAuthClient({ refreshToken: refreshFn });

    createAuthInterceptor(instance, client);

    instance.defaults.adapter = async (config) => {
      const error = new axios.AxiosError('Forbidden', '403', config as never, null, {
        status: 403,
        statusText: 'Forbidden',
        data: {},
        headers: {},
        config: config as never,
      });
      throw error;
    };

    await expect(instance.get('/test')).rejects.toBeDefined();
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('does not infinite loop on retry', async () => {
    const instance = axios.create();
    const refreshFn = jest.fn(async (): Promise<AuthTokens> => ({
      accessToken: 'still-bad',
      refreshToken: 'still-bad',
      expiresIn: 3600,
    }));
    const signOutFn = jest.fn();
    const client = createMockAuthClient({
      refreshToken: refreshFn,
      signOut: signOutFn,
    });

    createAuthInterceptor(instance, client);

    // Always return 401
    instance.defaults.adapter = async (config) => {
      const error = new axios.AxiosError('Unauthorized', '401', config as never, null, {
        status: 401,
        statusText: 'Unauthorized',
        data: {},
        headers: {},
        config: config as never,
      });
      throw error;
    };

    await expect(instance.get('/protected')).rejects.toBeDefined();
    // Refresh called once for initial 401, retry 401 has _retry=true so skipped
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });
});

/** @jest-environment jsdom */
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth, useAuthClient } from '../auth-provider';
import type { AuthAdapter, AuthClientConfig } from '../types';
import { __resetStoreModules } from '../secure-token-store';
import { __resetSecureStore } from '../../__mocks__/expo-secure-store';
import { __reset as resetJwtDecode } from '../../__mocks__/jwt-decode';

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
    ...overrides,
  };
}

function createWrapper(config: AuthClientConfig) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <AuthProvider config={config}>{children}</AuthProvider>;
  };
}

beforeEach(() => {
  __resetStoreModules();
  __resetSecureStore();
  resetJwtDecode();
});

describe('AuthProvider', () => {
  it('renders children', () => {
    const adapter = createMockAdapter();
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper({ adapter }),
    });

    // Should not throw, should have initial state
    expect(result.current).toBeDefined();
  });

  it('useAuth returns initial state with action functions', () => {
    const adapter = createMockAdapter();
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper({ adapter }),
    });

    expect(result.current.status).toBeDefined();
    expect(typeof result.current.signIn).toBe('function');
    expect(typeof result.current.signOut).toBe('function');
  });

  it('calls hydrate on mount and transitions through authenticating', async () => {
    const adapter = createMockAdapter();
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper({ adapter }),
    });

    // hydrate() is called in useEffect — initially may show 'authenticating'
    // then settles to 'idle' since no stored tokens
    await act(async () => {
      // let the hydrate effect complete
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.isLoading).toBe(false);
  });

  it('useAuth throws outside AuthProvider', () => {
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow('useAuth must be used within an AuthProvider');
  });

  it('signIn updates state to authenticated', async () => {
    const adapter = createMockAdapter();
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper({ adapter }),
    });

    await act(async () => {
      await result.current.signIn({ username: 'test', password: 'pass' });
    });

    expect(result.current.status).toBe('authenticated');
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.user?.id).toBe('user-1');
  });

  it('signOut returns to idle', async () => {
    const adapter = createMockAdapter();
    const { result } = renderHook(() => useAuth(), {
      wrapper: createWrapper({ adapter }),
    });

    await act(async () => {
      await result.current.signIn({ username: 'test' });
    });
    expect(result.current.status).toBe('authenticated');

    await act(async () => {
      await result.current.signOut();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.isAuthenticated).toBe(false);
  });

  it('useAuthClient throws outside AuthProvider', () => {
    expect(() => {
      renderHook(() => useAuthClient());
    }).toThrow('useAuthClient must be used within an AuthProvider');
  });
});

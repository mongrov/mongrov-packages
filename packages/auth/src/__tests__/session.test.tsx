/** @jest-environment jsdom */
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../auth-provider';
import { useSession } from '../session';
import type { AuthAdapter, AuthClientConfig } from '../types';
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
    ...overrides,
  };
}

function createWrapper(config: AuthClientConfig) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <AuthProvider config={config}>{children}</AuthProvider>;
  };
}

function useCombined() {
  return {
    session: useSession(),
    auth: useAuth(),
  };
}

beforeEach(() => {
  __resetStoreModules();
  __resetSecureStore();
  resetJwtDecode();
});

describe('useSession', () => {
  it('returns null when not authenticated', () => {
    const adapter = createMockAdapter();
    const { result } = renderHook(() => useCombined(), {
      wrapper: createWrapper({ adapter }),
    });

    expect(result.current.session).toBeNull();
  });

  it('returns session when authenticated', async () => {
    __setDecoded({
      sub: 'user-1',
      email: 'test@example.com',
      name: 'Test User',
      roles: ['admin', 'user'],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const adapter = createMockAdapter();
    const { result } = renderHook(() => useCombined(), {
      wrapper: createWrapper({ adapter }),
    });

    await act(async () => {
      await result.current.auth.signIn({ username: 'test' });
    });

    const session = result.current.session;
    expect(session).not.toBeNull();
    expect(session!.user.id).toBe('user-1');
    expect(session!.accessToken).toBe('access-123');
  });

  it('hasPermission checks roles', async () => {
    __setDecoded({
      sub: 'user-1',
      roles: ['admin', 'editor'],
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const adapter = createMockAdapter();
    const { result } = renderHook(() => useCombined(), {
      wrapper: createWrapper({ adapter }),
    });

    await act(async () => {
      await result.current.auth.signIn({ username: 'test' });
    });

    const session = result.current.session;
    expect(session!.hasPermission('admin')).toBe(true);
    expect(session!.hasPermission('editor')).toBe(true);
    expect(session!.hasPermission('viewer')).toBe(false);
  });

  it('permissions default to empty array when no roles', async () => {
    __setDecoded({
      sub: 'user-1',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const adapter = createMockAdapter();
    const { result } = renderHook(() => useCombined(), {
      wrapper: createWrapper({ adapter }),
    });

    await act(async () => {
      await result.current.auth.signIn({ username: 'test' });
    });

    const session = result.current.session;
    expect(session).not.toBeNull();
    expect(session!.permissions).toEqual([]);
    expect(session!.hasPermission('anything')).toBe(false);
  });
});

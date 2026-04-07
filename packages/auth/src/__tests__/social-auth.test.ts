/**
 * @jest-environment jsdom
 */

/**
 * Tests for social authentication hooks
 */

import { renderHook, act } from '@testing-library/react';
import { Platform } from 'react-native';

import { useAppleAuth, useGoogleAuth, useSocialAuth } from '../social-auth';

// Mock Platform
jest.mock('react-native', () => ({
  Platform: {
    OS: 'ios',
    select: jest.fn((options) => options.ios ?? options.default),
  },
}));

// Mock expo-apple-authentication
const mockAppleSignIn = jest.fn();
const mockAppleIsAvailable = jest.fn();

jest.mock('expo-apple-authentication', () => ({
  signInAsync: mockAppleSignIn,
  isAvailableAsync: mockAppleIsAvailable,
  AppleAuthenticationScope: {
    FULL_NAME: 0,
    EMAIL: 1,
  },
}));

// Mock expo-auth-session
const mockPromptAsync = jest.fn();
const mockMakeAuthUrlAsync = jest.fn();

jest.mock('expo-auth-session', () => ({
  makeRedirectUri: jest.fn(() => 'exp://redirect'),
  ResponseType: {
    Token: 'token',
  },
  AuthRequest: jest.fn().mockImplementation(() => ({
    makeAuthUrlAsync: mockMakeAuthUrlAsync,
    promptAsync: mockPromptAsync,
  })),
}));

jest.mock('expo-auth-session/providers/google', () => ({
  discovery: {
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
  },
}));

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
}));

describe('useAppleAuth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (Platform.OS as string) = 'ios';
    mockAppleIsAvailable.mockResolvedValue(true);
  });

  it('should return initial state', () => {
    const { result } = renderHook(() => useAppleAuth());

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isAvailable).toBe(true);
    expect(typeof result.current.signIn).toBe('function');
    expect(typeof result.current.clearError).toBe('function');
  });

  it('should return isAvailable: false on non-iOS platforms', () => {
    (Platform.OS as string) = 'android';

    const { result } = renderHook(() => useAppleAuth());

    expect(result.current.isAvailable).toBe(false);
  });

  it('should handle successful Apple sign-in', async () => {
    const mockCredential = {
      identityToken: 'mock-identity-token',
      authorizationCode: 'mock-auth-code',
      email: 'test@example.com',
      fullName: {
        givenName: 'John',
        familyName: 'Doe',
      },
    };
    mockAppleSignIn.mockResolvedValue(mockCredential);

    const { result } = renderHook(() => useAppleAuth());

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    expect(signInResult).toEqual({
      provider: 'apple',
      identityToken: 'mock-identity-token',
      authorizationCode: 'mock-auth-code',
      user: {
        email: 'test@example.com',
        fullName: {
          givenName: 'John',
          familyName: 'Doe',
        },
      },
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('should handle user cancellation', async () => {
    const cancelError = new Error('User canceled');
    (cancelError as any).code = 'ERR_REQUEST_CANCELED';
    mockAppleSignIn.mockRejectedValue(cancelError);

    const { result } = renderHook(() => useAppleAuth());

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    // Cancellation returns null without error
    expect(signInResult).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('should handle sign-in failure', async () => {
    mockAppleSignIn.mockRejectedValue(new Error('Auth failed'));

    const { result } = renderHook(() => useAppleAuth());

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    expect(signInResult).toBeNull();
    expect(result.current.error).toEqual({
      code: 'SOCIAL_AUTH_FAILED',
      message: 'Auth failed',
      original: expect.any(Error),
    });
  });

  it('should clear error', async () => {
    mockAppleSignIn.mockRejectedValue(new Error('Auth failed'));

    const { result } = renderHook(() => useAppleAuth());

    await act(async () => {
      await result.current.signIn();
    });

    expect(result.current.error).not.toBeNull();

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBeNull();
  });

  it('should set error when not available on current platform', async () => {
    (Platform.OS as string) = 'android';

    const { result } = renderHook(() => useAppleAuth());

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    expect(signInResult).toBeNull();
    expect(result.current.error?.code).toBe('NOT_SUPPORTED');
  });
});

describe('useGoogleAuth', () => {
  const config = {
    webClientId: 'test-web-client-id.apps.googleusercontent.com',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockMakeAuthUrlAsync.mockResolvedValue(undefined);
  });

  it('should return initial state', () => {
    const { result } = renderHook(() => useGoogleAuth(config));

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.isAvailable).toBe(true);
  });

  it('should handle successful Google sign-in', async () => {
    mockPromptAsync.mockResolvedValue({
      type: 'success',
      params: {
        idToken: 'mock-id-token',
        accessToken: 'mock-access-token',
      },
    });

    const { result } = renderHook(() => useGoogleAuth(config));

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    expect(signInResult).toEqual({
      provider: 'google',
      idToken: 'mock-id-token',
      accessToken: 'mock-access-token',
    });
  });

  it('should handle user cancellation', async () => {
    mockPromptAsync.mockResolvedValue({
      type: 'cancel',
    });

    const { result } = renderHook(() => useGoogleAuth(config));

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    expect(signInResult).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('should handle sign-in failure', async () => {
    mockPromptAsync.mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useGoogleAuth(config));

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signIn();
    });

    expect(signInResult).toBeNull();
    expect(result.current.error?.code).toBe('SOCIAL_AUTH_FAILED');
  });
});

describe('useSocialAuth', () => {
  const config = {
    google: {
      webClientId: 'test.apps.googleusercontent.com',
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (Platform.OS as string) = 'ios';
    mockAppleIsAvailable.mockResolvedValue(true);
    mockMakeAuthUrlAsync.mockResolvedValue(undefined);
  });

  it('should provide access to all social auth providers', () => {
    const { result } = renderHook(() => useSocialAuth(config));

    expect(result.current.apple).toBeDefined();
    expect(result.current.google).toBeDefined();
    expect(typeof result.current.signInWith).toBe('function');
    expect(result.current.loading).toBe(false);
  });

  it('should aggregate loading state', async () => {
    mockAppleSignIn.mockImplementation(() => new Promise(() => {})); // Never resolves

    const { result } = renderHook(() => useSocialAuth(config));

    // Start sign-in (don't await)
    act(() => {
      result.current.apple.signIn();
    });

    // Loading should be true
    expect(result.current.loading).toBe(true);
  });

  it('should signInWith apple', async () => {
    mockAppleSignIn.mockResolvedValue({
      identityToken: 'token',
      authorizationCode: 'code',
    });

    const { result } = renderHook(() => useSocialAuth(config));

    let signInResult: any;
    await act(async () => {
      signInResult = await result.current.signInWith('apple');
    });

    expect(signInResult?.provider).toBe('apple');
  });

  it('should throw for unsupported provider', async () => {
    const { result } = renderHook(() => useSocialAuth(config));

    await expect(async () => {
      await act(async () => {
        await result.current.signInWith('github');
      });
    }).rejects.toThrow('GitHub authentication not yet implemented');
  });
});

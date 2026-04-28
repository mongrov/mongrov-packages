/**
 * Social Authentication Hooks
 *
 * Native social login hooks for Apple and Google using Expo libraries.
 * These hooks handle the OAuth flow and return credentials that can be
 * passed to your AuthAdapter.
 *
 * Usage:
 * ```tsx
 * const { signIn, loading, error } = useAppleAuth();
 * const result = await signIn(); // Returns AppleAuthResult
 * // Pass result to your adapter: authClient.signIn({ provider: 'apple', ...result })
 * ```
 */

import { useCallback, useState } from 'react';
import { Platform } from 'react-native';

import type { AuthErrorCode, SocialProvider } from './types';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SocialAuthError {
  code: AuthErrorCode;
  message: string;
  original?: Error;
}

export interface AppleAuthResult {
  provider: 'apple';
  /** Apple identity token (JWT) */
  identityToken: string;
  /** Authorization code for server validation */
  authorizationCode: string;
  /** User info (only available on first sign-in) */
  user?: {
    email?: string | null;
    fullName?: {
      givenName?: string | null;
      familyName?: string | null;
    };
  };
}

export interface GoogleAuthResult {
  provider: 'google';
  /** Google ID token (JWT) */
  idToken: string;
  /** Access token for Google APIs (may be null) */
  accessToken: string | null;
}

export type SocialAuthResult = AppleAuthResult | GoogleAuthResult;

export interface SocialAuthHookResult<T extends SocialAuthResult> {
  /** Trigger the sign-in flow */
  signIn: () => Promise<T | null>;
  /** Whether sign-in is in progress */
  loading: boolean;
  /** Last error that occurred */
  error: SocialAuthError | null;
  /** Clear the error state */
  clearError: () => void;
  /** Whether this provider is available on current platform */
  isAvailable: boolean;
}

// ─── Apple Authentication ────────────────────────────────────────────────────

/**
 * Hook for Apple Sign In using expo-apple-authentication.
 *
 * Requirements:
 * - iOS 13+ (returns isAvailable: false on older versions and other platforms)
 * - expo-apple-authentication must be installed
 * - Proper entitlements configured in app.json
 *
 * @example
 * ```tsx
 * const { signIn, loading, error, isAvailable } = useAppleAuth();
 *
 * if (!isAvailable) return null;
 *
 * const handleAppleSignIn = async () => {
 *   const result = await signIn();
 *   if (result) {
 *     await authClient.signIn({ provider: 'apple', token: result.identityToken });
 *   }
 * };
 * ```
 */
export function useAppleAuth(): SocialAuthHookResult<AppleAuthResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SocialAuthError | null>(null);

  // Apple Sign In is only available on iOS
  const isAvailable = Platform.OS === 'ios';

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const signIn = useCallback(async (): Promise<AppleAuthResult | null> => {
    if (!isAvailable) {
      setError({
        code: 'NOT_SUPPORTED',
        message: 'Apple Sign In is only available on iOS',
      });
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      // Dynamically import to avoid bundling issues on non-iOS platforms
      const AppleAuthentication = await import('expo-apple-authentication');

      // Check if available at runtime (iOS 13+)
      const available = await AppleAuthentication.isAvailableAsync();
      if (!available) {
        throw new Error('Apple Sign In is not available on this device');
      }

      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      });

      if (!credential.identityToken || !credential.authorizationCode) {
        throw new Error('Apple Sign In did not return required tokens');
      }

      const result: AppleAuthResult = {
        provider: 'apple',
        identityToken: credential.identityToken,
        authorizationCode: credential.authorizationCode,
        user: credential.email || credential.fullName
          ? {
              email: credential.email,
              fullName: credential.fullName
                ? {
                    givenName: credential.fullName.givenName,
                    familyName: credential.fullName.familyName,
                  }
                : undefined,
            }
          : undefined,
      };

      return result;
    } catch (err) {
      const error = err as Error & { code?: string };

      // Handle user cancellation
      if (error.code === 'ERR_REQUEST_CANCELED') {
        // User cancelled - not an error
        return null;
      }

      setError({
        code: 'SOCIAL_AUTH_FAILED',
        message: error.message || 'Apple Sign In failed',
        original: error,
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [isAvailable]);

  return {
    signIn,
    loading,
    error,
    clearError,
    isAvailable,
  };
}

// ─── Google Authentication ───────────────────────────────────────────────────

export interface GoogleAuthConfig {
  /** Google OAuth client ID for iOS */
  iosClientId?: string;
  /** Google OAuth client ID for Android */
  androidClientId?: string;
  /** Google OAuth client ID for web (Expo Go uses this) */
  webClientId?: string;
  /** Additional OAuth scopes beyond openid/email/profile */
  scopes?: string[];
}

/**
 * Hook for Google Sign In using @react-native-google-signin/google-signin v16.
 *
 * Requirements:
 * - @react-native-google-signin/google-signin v16+ installed
 * - On Android: clientId auto-detected from google-services.json
 * - On iOS: iosClientId and webClientId required
 *
 * @example
 * ```tsx
 * const { signIn, loading, error } = useGoogleAuth({
 *   iosClientId: 'xxx.apps.googleusercontent.com',
 *   webClientId: 'zzz.apps.googleusercontent.com',
 * });
 *
 * const handleGoogleSignIn = async () => {
 *   const result = await signIn();
 *   if (result) {
 *     await authClient.signIn({ provider: 'google', token: result.idToken });
 *   }
 * };
 * ```
 */
export function useGoogleAuth(config: GoogleAuthConfig): SocialAuthHookResult<GoogleAuthResult> {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<SocialAuthError | null>(null);

  // Google auth is available on all platforms
  const isAvailable = true;

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const signIn = useCallback(async (): Promise<GoogleAuthResult | null> => {
    setLoading(true);
    setError(null);

    try {
      const { GoogleSignin, isSuccessResponse, isCancelledResponse } =
        await import('@react-native-google-signin/google-signin');

      GoogleSignin.configure({
        webClientId: config.webClientId,
        iosClientId: config.iosClientId,
        offlineAccess: true,
      });

      if (Platform.OS === 'android') {
        await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
      }

      const response = await GoogleSignin.signIn();

      if (isCancelledResponse(response)) {
        return null;
      }

      if (!isSuccessResponse(response)) {
        throw new Error('Google Sign In did not return a success response');
      }

      const idToken = response.data?.idToken;
      if (!idToken) {
        throw new Error('Google Sign In did not return an idToken');
      }

      const tokens = await GoogleSignin.getTokens();

      return {
        provider: 'google',
        idToken,
        accessToken: tokens.accessToken ?? null,
      };
    } catch (err) {
      const error = err as Error;
      setError({
        code: 'SOCIAL_AUTH_FAILED',
        message: error.message || 'Google Sign In failed',
        original: error,
      });
      return null;
    } finally {
      setLoading(false);
    }
  }, [config.webClientId, config.iosClientId]);

  return {
    signIn,
    loading,
    error,
    clearError,
    isAvailable,
  };
}

// ─── Generic Social Auth Hook ────────────────────────────────────────────────

export interface SocialAuthConfig {
  /** Google OAuth configuration */
  google?: GoogleAuthConfig;
}

/**
 * Generic social auth hook that provides access to all social providers.
 *
 * @example
 * ```tsx
 * const { apple, google, signInWith, loading } = useSocialAuth({
 *   google: { webClientId: 'xxx.apps.googleusercontent.com' },
 * });
 *
 * // Use provider-specific hooks
 * await apple.signIn();
 *
 * // Or use the generic signInWith
 * await signInWith('google');
 * ```
 */
export function useSocialAuth(config: SocialAuthConfig = {}) {
  const apple = useAppleAuth();
  const google = useGoogleAuth(config.google || {});

  const signInWith = useCallback(
    async (provider: SocialProvider): Promise<SocialAuthResult | null> => {
      switch (provider) {
        case 'apple':
          return apple.signIn();
        case 'google':
          return google.signIn();
        case 'github':
          // GitHub not implemented yet - would use expo-auth-session
          throw new Error('GitHub authentication not yet implemented');
        default:
          throw new Error(`Unknown provider: ${provider}`);
      }
    },
    [apple, google]
  );

  return {
    apple,
    google,
    signInWith,
    loading: apple.loading || google.loading,
  };
}

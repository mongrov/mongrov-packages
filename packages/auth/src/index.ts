// Factory
export { createAuthClient } from './auth-client';

// Context
export { AuthProvider, useAuth, useAuthClient } from './auth-provider';

// Session
export { useSession } from './session';

// Storage
export { SecureTokenStore } from './secure-token-store';

// Interceptor — exported via '@mongrov/auth/interceptor' subpath
// to avoid leaking axios types into the main entry point.
// import { createAuthInterceptor } from '@mongrov/auth/interceptor';

// Biometric
export { useBiometricGate } from './biometric';

// Social Auth — exported via '@mongrov/auth/social-auth' subpath
// to avoid pulling expo-apple-authentication + @react-native-google-signin/google-signin
// into the main entry point. Apps that don't use social auth pay nothing.
// import { useSocialAuth } from '@mongrov/auth/social-auth';

// Types
export type {
  AuthAdapter,
  AuthTokens,
  AuthState,
  AuthStatus,
  AuthError,
  AuthErrorCode,
  AuthClient,
  AuthClientConfig,
  AuthLogger,
  TokenStore,
  UserInfo,
  Session,
  // Tenant types
  TenantConfig,
  AuthMethodConfig,
  SocialProvider,
  BackendConfig,
  TenantContext,
} from './types';

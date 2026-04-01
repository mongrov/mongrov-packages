// Factory
export { createAuthClient } from './auth-client';

// Context
export { AuthProvider, useAuth } from './auth-provider';

// Session
export { useSession } from './session';

// Storage
export { SecureTokenStore } from './secure-token-store';

// Interceptor
export { createAuthInterceptor } from './interceptor';

// Biometric
export { useBiometricGate } from './biometric';

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
} from './types';

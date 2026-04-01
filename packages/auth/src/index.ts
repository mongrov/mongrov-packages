// Factory
export { createAuthClient } from './auth-client';

// Context
export { AuthProvider, useAuth } from './auth-provider';

// Session
export { useSession } from './session';

// Storage
export { SecureTokenStore } from './secure-token-store';

// Interceptor — exported via '@mongrov/auth/interceptor' subpath
// to avoid leaking axios types into the main entry point.
// import { createAuthInterceptor } from '@mongrov/auth/interceptor';

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

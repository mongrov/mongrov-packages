// Factory
export { createAuthClient } from './auth-client'

// Context
export { AuthProvider, useAuth, useAuthClient } from './auth-provider'

// Biometric
export { useBiometricGate } from './biometric'

// Storage
export { SecureTokenStore } from './secure-token-store'

// Interceptor — exported via '@mongrov/auth/interceptor' subpath
// to avoid leaking axios types into the main entry point.
// import { createAuthInterceptor } from '@mongrov/auth/interceptor';

// Session
export { useSession } from './session'

// Social Auth — exported via '@mongrov/auth/social-auth' subpath
// to avoid pulling expo-apple-authentication + @react-native-google-signin/google-signin
// into the main entry point. Apps that don't use social auth pay nothing.
// import { useSocialAuth } from '@mongrov/auth/social-auth';

// Types
export type {
  AuthAdapter,
  AuthClient,
  AuthClientConfig,
  AuthError,
  AuthErrorCode,
  AuthLogger,
  AuthMethodConfig,
  AuthState,
  AuthStatus,
  AuthTokens,
  BackendConfig,
  Session,
  SocialProvider,
  // Tenant types
  TenantConfig,
  TenantContext,
  TokenStore,
  UserInfo,
} from './types'

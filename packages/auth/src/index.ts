// Backend adapters. axios (an optional peer) is loaded only when the
// Rocket.Chat password adapter or the Odoo adapter is created.
export { createOdooAdapter } from './adapters/odoo'

export type { OdooAdapterConfig } from './adapters/odoo'

export { createRocketChatAdapter } from './adapters/rocketchat'

export type { RocketChatAdapterConfig } from './adapters/rocketchat'
export {
  createRocketChatSessionAdapter,
  ROCKETCHAT_REVOKE_TIMEOUT_MS,
} from './adapters/rocketchat-session'
export type {
  RocketChatCredentials,
  RocketChatMe,
  RocketChatSessionAdapterOptions,
  RocketChatSessionPort,
} from './adapters/rocketchat-session'

// Factory
export { createAuthClient } from './auth-client'
// Context
export { AuthProvider, useAuth, useAuthClient } from './auth-provider'
// Biometric
export { useBiometricGate } from './biometric'
// Log redaction shared with apps that forward auth lines into their own logger
export { redactAuthString } from './log'
export { createSecureCredentials, SECURE_STORE_KEY_PATTERN } from './secure-credentials'
export type {
  CredentialKeyOf,
  LegacyCredentialStore,
  SecureCredentials,
  SecureCredentialsOptions,
} from './secure-credentials'

// Storage
export { createSecureTokenStore, SecureTokenStore } from './secure-token-store'

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

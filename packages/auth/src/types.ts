// ─── Adapter (app implements this) ─────────────────────

export interface AuthAdapter {
  /** Exchange credentials for tokens */
  login: (credentials: Record<string, unknown>) => Promise<AuthTokens>
  /** Refresh access token using refresh token */
  refresh: (refreshToken: string) => Promise<AuthTokens>
  /** Server-side logout — optional */
  logout?: (accessToken: string) => Promise<void>
  /** Fetch user profile — optional (falls back to JWT decode) */
  getUser?: (accessToken: string) => Promise<UserInfo>
}

export interface AuthTokens {
  accessToken: string
  refreshToken?: string
  expiresIn?: number // seconds until access token expires
}

// ─── State Machine ─────────────────────────────────────

export type AuthStatus = 'idle' | 'authenticating' | 'authenticated' | 'error'

export interface AuthState {
  status: AuthStatus
  user: UserInfo | null
  error: AuthError | null
  isAuthenticated: boolean // derived: status === 'authenticated'
  isLoading: boolean // derived: status === 'authenticating'
  /** True once hydrate() has completed (regardless of outcome). False before hydrate finishes. */
  isHydrated: boolean
}

export interface AuthError {
  code: AuthErrorCode
  message: string
  original?: Error
}

export type AuthErrorCode
  = | 'INVALID_CREDENTIALS'
    | 'TOKEN_EXPIRED'
    | 'REFRESH_FAILED'
    | 'NETWORK_ERROR'
    | 'BIOMETRIC_FAILED'
    | 'ADAPTER_ERROR'
    | 'UNKNOWN'
  // Social/SSO errors
    | 'SOCIAL_AUTH_FAILED'
    | 'SSO_CONFIG_ERROR'
    | 'SSO_AUTH_FAILED'
  // Account errors
    | 'RATE_LIMITED'
    | 'ACCOUNT_LOCKED'
    | 'DUPLICATE_EMAIL'
    | 'VALIDATION_ERROR'
    | 'REGISTRATION_DISABLED'
    | 'NOT_SUPPORTED'
    | 'STORAGE_ERROR'

// ─── User / Session ────────────────────────────────────

export interface UserInfo {
  id: string
  email?: string
  name?: string
  avatar?: string
  roles?: string[]
  /**
   * IANA zone, e.g. `'America/Los_Angeles'`. The user's own attribute, not
   * the device's.
   *
   * Load-bearing rather than cosmetic. Every timestamp is stored in UTC, so
   * this is the only thing that decides which local day a reading belongs
   * to — sleep-session attribution via the 6pm-6pm rule (principle 24),
   * baseline compute grouping by local day (principle 27), and day-cadence
   * rules. Mirrors `User.timezone` in `@mongrov/types/tenancy`, which is the
   * analytics plane's model of the same attribute.
   *
   * Typed rather than left to the extensible index because consumers pass it
   * into query parameters: an untyped `session.user.timezone` reads as
   * `unknown` and gets cast at each call site, which is how a device
   * timezone ends up substituted for a user's without anyone noticing.
   *
   * Optional: a profile captured before this field existed has none, and the
   * consumer decides what to do about that. Falling back to the device zone
   * silently is what it must NOT do without saying so.
   */
  timezone?: string
  [key: string]: unknown // extensible
}

export interface Session {
  user: UserInfo
  tenant?: string
  permissions: string[]
  hasPermission: (permission: string) => boolean
  accessToken: string
}

// ─── Logger (compatible with @mongrov/core) ────────────

export interface AuthLogger {
  debug: (message: string, ...args: unknown[]) => void
  info: (message: string, ...args: unknown[]) => void
  warn: (message: string, ...args: unknown[]) => void
  error: (message: string, ...args: unknown[]) => void
}

// ─── Token Store ────────────────────────────────────────

export interface TokenStore {
  getAccessToken: () => Promise<string | null>
  setAccessToken: (token: string) => Promise<void>
  getRefreshToken: () => Promise<string | null>
  setRefreshToken: (token: string) => Promise<void>
  clear: () => Promise<void>
}

// ─── Tenant Config ─────────────────────────────────────

export interface TenantConfig {
  id: string
  name: string
  /** Logo image source (require() or { uri: string }) */
  logo?: unknown
  auth: AuthMethodConfig
  backend: BackendConfig
}

export type AuthMethodConfig
  = | { method: 'email-password' }
    | { method: 'social', providers: SocialProvider[] }
    | { method: 'sso', provider: string, issuer: string, clientId: string, scopes?: string[] }
    | { method: 'composite', primary: AuthMethodConfig, alternatives: AuthMethodConfig[] }

export type SocialProvider = 'apple' | 'google' | 'github'

export type BackendConfig
  = | { type: 'odoo', url: string }
    | { type: 'rocketchat', url: string }
    | { type: 'postgres', url: string }

export interface TenantContext {
  tenant: TenantConfig | null
  tenants: TenantConfig[]
  setTenant: (tenantId: string | null) => void
  /** True when tenants.length > 1 */
  isMultiTenant: boolean
  /** True once tenant config has loaded from storage */
  isReady: boolean
}

// ─── Config ────────────────────────────────────────────

export interface AuthClientConfig {
  adapter: AuthAdapter
  /** Token persistence backend. Default: SecureTokenStore (expo-secure-store → MMKV fallback) */
  tokenStore?: TokenStore
  /** Enable proactive token refresh before expiry. Default: true */
  proactiveRefresh?: boolean
  /** Refresh at this % of expiresIn (0-1). Default: 0.8 */
  refreshThreshold?: number
  /** Extract UserInfo from JWT if adapter.getUser not provided */
  parseUserFromToken?: (decodedToken: Record<string, unknown>) => UserInfo
  /** Logger instance (e.g. from @mongrov/core useLogger()). Default: no-op */
  logger?: AuthLogger
}

// ─── Auth Client (returned by createAuthClient) ────────

export interface AuthClient {
  // State
  getState: () => AuthState
  subscribe: (listener: (state: AuthState) => void) => () => void

  // Actions
  signIn: (credentials: Record<string, unknown>) => Promise<void>
  signOut: () => Promise<void>
  hydrate: () => Promise<void>

  // Token access (for interceptor)
  getAccessToken: () => string | null
  getRefreshToken: () => string | null

  // Refresh
  refreshToken: () => Promise<AuthTokens>

  // Cleanup
  destroy: () => void
}

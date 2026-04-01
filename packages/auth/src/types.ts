// ─── Adapter (app implements this) ─────────────────────

export interface AuthAdapter {
  /** Exchange credentials for tokens */
  login(credentials: Record<string, unknown>): Promise<AuthTokens>;
  /** Refresh access token using refresh token */
  refresh(refreshToken: string): Promise<AuthTokens>;
  /** Server-side logout — optional */
  logout?(accessToken: string): Promise<void>;
  /** Fetch user profile — optional (falls back to JWT decode) */
  getUser?(accessToken: string): Promise<UserInfo>;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number; // seconds until access token expires
}

// ─── State Machine ─────────────────────────────────────

export type AuthStatus = 'idle' | 'authenticating' | 'authenticated' | 'error';

export interface AuthState {
  status: AuthStatus;
  user: UserInfo | null;
  error: AuthError | null;
  isAuthenticated: boolean; // derived: status === 'authenticated'
  isLoading: boolean; // derived: status === 'authenticating'
  /** True once hydrate() has completed (regardless of outcome). False before hydrate finishes. */
  isHydrated: boolean;
}

export interface AuthError {
  code: AuthErrorCode;
  message: string;
  original?: Error;
}

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'REFRESH_FAILED'
  | 'NETWORK_ERROR'
  | 'BIOMETRIC_FAILED'
  | 'ADAPTER_ERROR'
  | 'UNKNOWN';

// ─── User / Session ────────────────────────────────────

export interface UserInfo {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
  roles?: string[];
  [key: string]: unknown; // extensible
}

export interface Session {
  user: UserInfo;
  tenant?: string;
  permissions: string[];
  hasPermission: (permission: string) => boolean;
  accessToken: string;
}

// ─── Logger (compatible with @mongrov/core) ────────────

export interface AuthLogger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ─── Token Store ────────────────────────────────────────

export interface TokenStore {
  getAccessToken(): Promise<string | null>;
  setAccessToken(token: string): Promise<void>;
  getRefreshToken(): Promise<string | null>;
  setRefreshToken(token: string): Promise<void>;
  clear(): Promise<void>;
}

// ─── Config ────────────────────────────────────────────

export interface AuthClientConfig {
  adapter: AuthAdapter;
  /** Token persistence backend. Default: SecureTokenStore (expo-secure-store → MMKV fallback) */
  tokenStore?: TokenStore;
  /** Enable proactive token refresh before expiry. Default: true */
  proactiveRefresh?: boolean;
  /** Refresh at this % of expiresIn (0-1). Default: 0.8 */
  refreshThreshold?: number;
  /** Extract UserInfo from JWT if adapter.getUser not provided */
  parseUserFromToken?: (decodedToken: Record<string, unknown>) => UserInfo;
  /** Logger instance (e.g. from @mongrov/core useLogger()). Default: no-op */
  logger?: AuthLogger;
}

// ─── Auth Client (returned by createAuthClient) ────────

export interface AuthClient {
  // State
  getState(): AuthState;
  subscribe(listener: (state: AuthState) => void): () => void;

  // Actions
  signIn(credentials: Record<string, unknown>): Promise<void>;
  signOut(): Promise<void>;
  hydrate(): Promise<void>;

  // Token access (for interceptor)
  getAccessToken(): string | null;
  getRefreshToken(): string | null;

  // Refresh
  refreshToken(): Promise<AuthTokens>;

  // Cleanup
  destroy(): void;
}

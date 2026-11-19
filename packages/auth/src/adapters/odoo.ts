import type { AuthAdapter, AuthLogger, AuthTokens } from '../types'
import type { HttpClient } from './shared'

import { noopLogger, redactAuthString } from '../log'
import { assertNoPrivilegedConfig, createHttpClient, encodeBase64 } from './shared'

/**
 * Odoo authentication adapter.
 *
 * Odoo uses JSON-RPC for authentication. This adapter handles:
 * - Email/password login via /web/session/authenticate
 * - Session-based auth (Odoo doesn't use JWT by default)
 * - Optional OAuth login if Odoo OAuth module is installed
 *
 * Usage:
 * ```ts
 * import { createOdooAdapter } from '@mongrov/auth';
 *
 * const adapter = createOdooAdapter({
 *   baseUrl: 'https://your-odoo-instance.com',
 *   database: 'your-database-name',
 * });
 * ```
 */
export type OdooAdapterConfig = {
  /** Odoo instance URL (e.g., https://company.odoo.com) */
  baseUrl: string
  /** Odoo database name */
  database: string
  /** Optional: timeout in milliseconds */
  timeout?: number
  /** Optional: failure lines (redacted), never tokens. Default: no-op. */
  logger?: AuthLogger
}

type OdooSession = {
  uid: number
  session_id: string
  username: string
  name: string
  partner_id: number
  company_id: number
}

type OdooRpcResponse<T> = {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: {
    code: number
    message: string
    data: {
      name: string
      debug: string
      message: string
    }
  }
}

export function createOdooAdapter(config: OdooAdapterConfig): AuthAdapter {
  assertNoPrivilegedConfig(config, 'createOdooAdapter')
  const logger = config.logger ?? noopLogger
  const client: HttpClient = createHttpClient({
    baseURL: config.baseUrl,
    timeout: config.timeout ?? 30000,
    headers: {
      'Content-Type': 'application/json',
    },
    withCredentials: true, // Important for session cookies
  }, 'createOdooAdapter')

  let _currentSession: OdooSession | null = null

  /**
   * Make a JSON-RPC call to Odoo.
   */
  async function rpcCall<T>(
    endpoint: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const response = await client.post<OdooRpcResponse<T>>(endpoint, {
      jsonrpc: '2.0',
      method: 'call',
      params,
      id: Date.now(),
    })

    if (response.data.error) {
      throw new Error(response.data.error.data?.message ?? response.data.error.message)
    }

    return response.data.result as T
  }

  /**
   * Create a fake JWT-like token from Odoo session.
   * This allows the session to work with @mongrov/auth's token-based flow.
   */
  function createSessionToken(session: OdooSession): string {
    const payload = {
      sub: String(session.uid),
      email: session.username,
      name: session.name,
      partner_id: session.partner_id,
      company_id: session.company_id,
      session_id: session.session_id,
      iat: Math.floor(Date.now() / 1000),
      // Odoo sessions typically last 7 days
      exp: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    }
    const header = encodeBase64(JSON.stringify({ alg: 'none', typ: 'JWT' }))
    const body = encodeBase64(JSON.stringify(payload))
    return `${header}.${body}.odoo`
  }

  return {
    async login(credentials): Promise<AuthTokens> {
      const { email, password } = credentials as { email: string, password: string }

      // Authenticate with Odoo
      const session = await rpcCall<OdooSession>('/web/session/authenticate', {
        db: config.database,
        login: email,
        password,
      })

      if (!session || !session.uid) {
        throw new Error('Invalid credentials')
      }

      _currentSession = session

      // Create a token that can be decoded by @mongrov/auth
      const accessToken = createSessionToken(session)

      return {
        accessToken,
        refreshToken: session.session_id, // Use session_id as refresh token
        expiresIn: 7 * 24 * 60 * 60, // 7 days
      }
    },

    async refresh(_refreshToken): Promise<AuthTokens> {
      // Odoo sessions are maintained via cookies, not refresh tokens
      // Try to get the current session info
      try {
        const sessionInfo = await rpcCall<OdooSession>('/web/session/get_session_info', {})

        if (!sessionInfo || !sessionInfo.uid) {
          throw new Error('Session expired')
        }

        _currentSession = sessionInfo
        const accessToken = createSessionToken(sessionInfo)

        return {
          accessToken,
          refreshToken: sessionInfo.session_id,
          expiresIn: 7 * 24 * 60 * 60,
        }
      }
      catch (error) {
        // Rethrown to @mongrov/auth, which logs the refresh failure; the
        // cause is logged here because the rethrow replaces it.
        logger.warn('[Auth] Odoo session refresh failed', { error: redactAuthString(String(error)) })
        throw new Error('Session expired - please log in again')
      }
    },

    async logout(): Promise<void> {
      try {
        await rpcCall('/web/session/destroy', {})
      }
      catch (error) {
        // Not fatal: the local session is dropped below regardless.
        logger.warn('[Auth] Odoo server logout failed', { error: redactAuthString(String(error)) })
      }
      _currentSession = null
    },
  }
}

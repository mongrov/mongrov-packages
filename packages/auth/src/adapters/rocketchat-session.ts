import type { AuthAdapter, AuthLogger, AuthTokens, UserInfo } from '../types'
import { noopLogger, redactAuthString } from '../log'
import { assertNoPrivilegedConfig, makeUnsignedJwt } from './shared'

/**
 * Auth adapter for an app whose sign-in is done by a Rocket.Chat client: the
 * client logs in, keeps the user's token in its own store, and hands the
 * token to `@mongrov/auth` through `signIn({ authToken, userId })`. The
 * adapter talks to that client only through `RocketChatSessionPort`, so the
 * package carries no app code.
 *
 * Only the signed-in user's own token is ever used. There is no option for an
 * admin or service token: anything in a client bundle is readable by whoever
 * holds the app, so privileged Rocket.Chat calls belong on a server.
 */

/** Rocket.Chat credentials of the signed-in user. */
export interface RocketChatCredentials {
  authToken: string
  userId: string
}

/** `GET /api/v1/me`, the fields the adapter reads. */
export interface RocketChatMe {
  _id?: string
  name?: string
  username?: string
  emails?: Array<{ address: string, verified?: boolean }>
}

/** What the adapter needs from the app's Rocket.Chat client and its credential store. */
export interface RocketChatSessionPort {
  /** Read on every call, never cached: the store is the source of truth. */
  getCredentials: () => { authToken: string | null, userId: string | null }
  /** Remove the stored token and user id from the device. Synchronous. */
  clearCredentials: () => void
  /** Called with the username `/me` returned, when it has one. */
  setUsername?: (username: string) => void
  /** `GET /me` with the stored credentials. */
  fetchMe: () => Promise<RocketChatMe>
  /**
   * `POST /logout` with exactly these credentials (captured before the store
   * is cleared). Reject on any failure; honour `signal`.
   */
  revoke: (credentials: RocketChatCredentials, signal: AbortSignal) => Promise<void>
}

export interface RocketChatSessionAdapterOptions {
  port: RocketChatSessionPort
  /** Default: no-op. Lines carry outcomes and HTTP statuses, never tokens or ids. */
  logger?: AuthLogger
  /** How long sign-out waits on the server before giving up on revoking. Default 3000 ms. */
  revokeTimeoutMs?: number
  /**
   * `expiresIn` reported for the wrapped token, in seconds. Rocket.Chat tokens
   * are long-lived; default one year. Keep `proactiveRefresh: false` in the
   * auth client: a timer this long overflows 32-bit `setTimeout`.
   */
  tokenLifetimeSeconds?: number
  /**
   * HTTP status in a failed request's error, or null. The status (never the
   * body) is what gets logged. Default: `error.status`, `error.response.status`,
   * or `HTTP <status>` in the error text.
   */
  httpStatusOf?: (error: unknown) => string | null
}

/** Default `revokeTimeoutMs`. */
export const ROCKETCHAT_REVOKE_TIMEOUT_MS = 3000

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365
const HTTP_STATUS = /HTTP (\d{3})/

export function defaultHttpStatusOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null) {
    const e = error as { status?: unknown, response?: { status?: unknown } }
    const status = e.status ?? e.response?.status
    if (typeof status === 'number')
      return String(status)
  }
  return HTTP_STATUS.exec(String(error))?.[1] ?? null
}

export function createRocketChatSessionAdapter(options: RocketChatSessionAdapterOptions): AuthAdapter {
  assertNoPrivilegedConfig(options, 'createRocketChatSessionAdapter')
  const { port } = options
  const log = options.logger ?? noopLogger
  const timeoutMs = options.revokeTimeoutMs ?? ROCKETCHAT_REVOKE_TIMEOUT_MS
  const lifetime = options.tokenLifetimeSeconds ?? ONE_YEAR_SECONDS
  const statusOf = options.httpStatusOf ?? defaultHttpStatusOf

  // `@mongrov/auth`'s hydrate() decodes the stored access token to check
  // expiry. Rocket.Chat tokens are not JWTs, so they are wrapped in a minimal
  // unsigned JWT carrying `exp`.
  const wrap = (userId: string) => makeUnsignedJwt({ sub: userId }, lifetime)

  /**
   * Revoke the token on the server. Best-effort: never throws, and gives up
   * after `timeoutMs`. Logs `auth.logout.server_revoke` with the outcome — a
   * status or a redacted error, never the token.
   */
  async function revokeOnServer(credentials: RocketChatCredentials): Promise<void> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        // Resolve before aborting, so the race reports a timeout rather than
        // the AbortError the request rejects with.
        resolve('timeout')
        controller.abort()
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([
        port.revoke(credentials, controller.signal).then(() => 'ok' as const),
        timedOut,
      ])
      if (result === 'ok')
        log.info('auth.logout.server_revoke', { outcome: 'ok' })
      else
        log.warn('auth.logout.server_revoke', { outcome: 'failed', reason: 'timeout', timeoutMs })
    }
    catch (error) {
      // The HTTP status only, never the body. Otherwise the error text, with
      // the token and user id cut out of it first.
      const status = statusOf(error)
      const scrubbed = String(error)
        .split(credentials.authToken)
        .join('[redacted]')
        .split(credentials.userId)
        .join('[redacted]')
      log.warn('auth.logout.server_revoke', status
        ? { outcome: 'failed', reason: 'http', status }
        : { outcome: 'failed', reason: 'network', error: redactAuthString(scrubbed).slice(0, 200) })
    }
    finally {
      clearTimeout(timer)
    }
  }

  return {
    async login(credentials: Record<string, unknown>): Promise<AuthTokens> {
      const authToken = credentials.authToken as string
      const userId = credentials.userId as string
      if (!authToken)
        throw new Error('rocketChatSessionAdapter.login: missing authToken')
      return { accessToken: wrap(userId || ''), refreshToken: authToken, expiresIn: lifetime }
    },

    async refresh(_refreshToken: string): Promise<AuthTokens> {
      // Rocket.Chat tokens do not expire: re-issue a fresh wrapper.
      const { authToken, userId } = port.getCredentials()
      if (!authToken)
        throw new Error('rocketChatSessionAdapter.refresh: no token, re-login required')
      return { accessToken: wrap(userId ?? ''), expiresIn: lifetime }
    },

    /**
     * The server call starts first, with the token captured, but the phone is
     * cleared without waiting for it: an offline or slow server must never
     * keep the user signed in. The auth client runs this fire-and-forget, so
     * the revoke is off the sign-out UI's path.
     */
    async logout(_accessToken: string): Promise<void> {
      const { authToken, userId } = port.getCredentials()
      const revoke = authToken && userId ? revokeOnServer({ authToken, userId }) : null
      port.clearCredentials()
      if (!revoke) {
        log.info('auth.logout.server_revoke', { outcome: 'skipped', reason: 'no_token' })
        return
      }
      await revoke
    },

    /**
     * NEVER returns an empty id. An empty string is a valid `UserInfo` id to
     * the auth client, so hydrate would succeed and the app look signed in
     * with no identity. Throwing makes hydrate fail and the user sign in
     * again. A `/me` failure is tolerated whenever the store has an id: a
     * transient network error must not sign anyone out.
     */
    async getUser(_accessToken: string): Promise<UserInfo> {
      const { userId } = port.getCredentials()
      try {
        const res = await port.fetchMe()
        if (res.username)
          port.setUsername?.(res.username)
        const id = userId ?? res._id
        if (!id)
          throw new Error('rocketChatSessionAdapter.getUser: no user id from store or /me')
        return { id, name: res.name ?? res.username, email: res.emails?.[0]?.address }
      }
      catch (error) {
        if (!userId) {
          // Rethrown: hydrate() turns it into HYDRATE_FAILURE and logs it.
          throw error instanceof Error ? error : new Error('rocketChatSessionAdapter.getUser: no user id available')
        }
        // The HTTP status only: /me's body is the user's profile.
        const status = statusOf(error)
        log.warn('[Auth] /me failed; restoring session from stored user id', status
          ? { status }
          : { error: redactAuthString(String(error)).slice(0, 200) })
        return { id: userId }
      }
    },
  }
}

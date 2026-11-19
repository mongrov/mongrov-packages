const B64_PLUS = /\+/g
const B64_SLASH = /\//g
const B64_PAD = /=+$/

// Hermes, browsers and Node 16+ provide these globals; the package's lib
// setting (ES2020, no DOM) does not declare them.
declare function btoa(data: string): string
declare function atob(data: string): string

export const encodeBase64 = (text: string): string => btoa(text)
export const decodeBase64 = (data: string): string => atob(data)

function b64url(value: object): string {
  return btoa(JSON.stringify(value))
    .replace(B64_PLUS, '-')
    .replace(B64_SLASH, '_')
    .replace(B64_PAD, '')
}

/**
 * A minimal unsigned (`alg: none`) JWT carrying `iat` and `exp`, so a backend
 * token that is not a JWT can go through the auth client's expiry check. It
 * is a local envelope, never sent to a server as a credential.
 */
export function makeUnsignedJwt(claims: Record<string, unknown>, lifetimeSeconds: number): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url({ alg: 'none', typ: 'JWT' })
  const payload = b64url({ ...claims, iat: now, exp: now + lifetimeSeconds })
  return `${header}.${payload}.`
}

/** Option names that would put a privileged credential into a client bundle. */
const PRIVILEGED = /admin|service.?token|server.?token|api.?secret|master/i

/**
 * Refuse admin or service credentials in an adapter's options. Every value a
 * client app is built with can be read out of the bundle, so a privileged
 * Rocket.Chat or Odoo call must be made by a server, never by these adapters.
 */
export function assertNoPrivilegedConfig(config: object, factory: string): void {
  const offending = Object.keys(config).filter(key => PRIVILEGED.test(key))
  if (offending.length > 0) {
    throw new Error(
      `${factory}: refusing ${offending.join(', ')}. Admin/service credentials must stay on a server, `
      + 'never in the app bundle; adapters use the signed-in user\'s own token only.',
    )
  }
}

/** The axios peer, loaded on first use so the main entry never imports it. */
interface AxiosLike {
  create: (config: Record<string, unknown>) => HttpClient
}

/** The subset of an axios instance the adapters use. */
export interface HttpClient {
  get: <T>(url: string, config?: Record<string, unknown>) => Promise<{ data: T }>
  post: <T>(url: string, body?: unknown, config?: Record<string, unknown>) => Promise<{ data: T }>
}

export function createHttpClient(config: Record<string, unknown>, factory: string): HttpClient {
  let mod: AxiosLike & { default?: AxiosLike }
  try {
    mod = require('axios') as AxiosLike & { default?: AxiosLike }
  }
  catch {
    throw new Error(`${factory} needs the optional peer dependency "axios"`)
  }
  const axios = typeof mod.create === 'function' ? mod : mod.default
  if (!axios)
    throw new Error(`${factory} needs the optional peer dependency "axios"`)
  return axios.create(config)
}

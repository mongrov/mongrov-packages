import type { RocketChatSessionPort } from '../adapters/rocketchat-session'
import {
  createRocketChatSessionAdapter,
  defaultHttpStatusOf,
  ROCKETCHAT_REVOKE_TIMEOUT_MS,
} from '../adapters/rocketchat-session'

type Creds = { authToken: string | null, userId: string | null }

let creds: Creds
let port: { [K in keyof RocketChatSessionPort]-?: jest.Mock }
let log: Record<'debug' | 'info' | 'warn' | 'error', jest.Mock>

function adapter() {
  return createRocketChatSessionAdapter({ port, logger: log })
}

function decode(jwt: string): Record<string, unknown> {
  const body = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(body, 'base64').toString('utf8'))
}

beforeEach(() => {
  creds = { authToken: 'rc-token', userId: 'user-1' }
  port = {
    getCredentials: jest.fn(() => creds),
    clearCredentials: jest.fn(),
    setUsername: jest.fn(),
    fetchMe: jest.fn(),
    revoke: jest.fn(),
  }
  log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
})

describe('login', () => {
  it('throws when authToken is missing', async () => {
    await expect(adapter().login({ userId: 'u1' })).rejects.toThrow('missing authToken')
  })

  it('returns an unsigned JWT with sub and a future exp, and the token as refreshToken', async () => {
    const result = await adapter().login({ authToken: 'rc-tok', userId: 'u1' })
    expect(result.accessToken).toMatch(/^[\w-]+\.[\w-]+\.$/)
    const payload = decode(result.accessToken)
    expect(payload.sub).toBe('u1')
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(result.refreshToken).toBe('rc-tok')
    expect(result.expiresIn).toBe(60 * 60 * 24 * 365)
  })

  it('uses an empty sub when userId is undefined', async () => {
    const result = await adapter().login({ authToken: 'rc-tok' })
    expect(decode(result.accessToken).sub).toBe('')
  })

  it('honours tokenLifetimeSeconds', async () => {
    const a = createRocketChatSessionAdapter({ port, tokenLifetimeSeconds: 60 })
    const result = await a.login({ authToken: 't', userId: 'u' })
    expect(result.expiresIn).toBe(60)
  })
})

describe('refresh', () => {
  it('re-issues a wrapper from the stored credentials', async () => {
    const result = await adapter().refresh('anything')
    expect(decode(result.accessToken).sub).toBe('user-1')
  })

  it('uses an empty sub when the store has no user id', async () => {
    creds = { authToken: 'rc-token', userId: null }
    const result = await adapter().refresh('x')
    expect(decode(result.accessToken).sub).toBe('')
  })

  it('throws when the store has no token', async () => {
    creds = { authToken: null, userId: null }
    await expect(adapter().refresh('x')).rejects.toThrow('re-login required')
  })
})

describe('logout (server revoke)', () => {
  // Token-shaped on purpose, so a leak into any log line is caught below.
  const TOKEN = 'rcTok3nSECRETvalue0123456789abcdef'
  const USER_ID = 'rcUser0123456789AB'

  beforeEach(() => {
    creds = { authToken: TOKEN, userId: USER_ID }
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  function expectNoSecretsLogged() {
    const lines = JSON.stringify(Object.values(log).map(m => m.mock.calls))
    expect(lines).not.toContain(TOKEN)
    expect(lines).not.toContain(USER_ID)
  }

  function revokeLog() {
    const calls = [...log.info.mock.calls, ...log.warn.mock.calls]
      .filter(([message]) => message === 'auth.logout.server_revoke')
    expect(calls).toHaveLength(1)
    return calls[0][1] as Record<string, unknown>
  }

  it('revokes the token on the server, then clears local credentials', async () => {
    port.revoke.mockResolvedValue(undefined)
    await adapter().logout?.('jwt')
    expect(port.revoke).toHaveBeenCalledWith({ authToken: TOKEN, userId: USER_ID }, expect.any(AbortSignal))
    expect(port.clearCredentials).toHaveBeenCalledTimes(1)
    expect(port.revoke.mock.invocationCallOrder[0]).toBeLessThan(port.clearCredentials.mock.invocationCallOrder[0])
    expect(log.info).toHaveBeenCalledWith('auth.logout.server_revoke', { outcome: 'ok' })
    expectNoSecretsLogged()
  })

  it('clears local credentials without waiting for the server', async () => {
    let settle!: () => void
    port.revoke.mockReturnValue(new Promise<void>((resolve) => {
      settle = resolve
    }))
    const done = adapter().logout?.('jwt')
    expect(port.clearCredentials).toHaveBeenCalledTimes(1)
    settle()
    await done
  })

  it('logs only the HTTP status when the server errors', async () => {
    port.revoke.mockRejectedValue(new Error(`HTTP 500: {"error":"boom ${TOKEN}"}`))
    await expect(adapter().logout?.('jwt')).resolves.toBeUndefined()
    expect(port.clearCredentials).toHaveBeenCalledTimes(1)
    expect(revokeLog()).toEqual({ outcome: 'failed', reason: 'http', status: '500' })
    expectNoSecretsLogged()
  })

  it('gives up after the timeout, aborts the request and still clears local credentials', async () => {
    jest.useFakeTimers()
    let signal: AbortSignal | undefined
    port.revoke.mockImplementation((_c: unknown, s: AbortSignal) => {
      signal = s
      return new Promise<void>((_resolve, reject) => {
        s.addEventListener('abort', () => reject(new Error('Aborted')))
      })
    })
    const done = adapter().logout?.('jwt')
    expect(port.clearCredentials).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(ROCKETCHAT_REVOKE_TIMEOUT_MS)
    await expect(done).resolves.toBeUndefined()
    expect(signal?.aborted).toBe(true)
    expect(revokeLog()).toEqual({ outcome: 'failed', reason: 'timeout', timeoutMs: ROCKETCHAT_REVOKE_TIMEOUT_MS })
    expectNoSecretsLogged()
  })

  it('signs out offline: network failure logged without the token', async () => {
    port.revoke.mockRejectedValue(new TypeError(`Network request failed (X-Auth-Token: ${TOKEN}, X-User-Id: ${USER_ID})`))
    await expect(adapter().logout?.('jwt')).resolves.toBeUndefined()
    expect(port.clearCredentials).toHaveBeenCalledTimes(1)
    const data = revokeLog()
    expect(data).toMatchObject({ outcome: 'failed', reason: 'network' })
    expect(String(data.error)).toContain('Network request failed')
    expectNoSecretsLogged()
  })

  it('skips the server call when there is no stored token', async () => {
    creds = { authToken: null, userId: null }
    await adapter().logout?.('jwt')
    expect(port.revoke).not.toHaveBeenCalled()
    expect(port.clearCredentials).toHaveBeenCalledTimes(1)
    expect(revokeLog()).toEqual({ outcome: 'skipped', reason: 'no_token' })
  })
})

describe('getUser', () => {
  it('returns id, name and email from /me and records the username', async () => {
    port.fetchMe.mockResolvedValue({ _id: 'u1', name: 'Alice', username: 'alice', emails: [{ address: 'alice@x.com' }] })
    const user = await adapter().getUser?.('tok')
    expect(user).toEqual({ id: 'user-1', name: 'Alice', email: 'alice@x.com' })
    expect(port.setUsername).toHaveBeenCalledWith('alice')
  })

  it('falls back to username for the name, and skips setUsername without one', async () => {
    port.fetchMe.mockResolvedValue({ _id: 'u1', username: 'bob', emails: [] })
    expect((await adapter().getUser?.('tok'))?.name).toBe('bob')
    port.setUsername.mockClear()
    port.fetchMe.mockResolvedValue({ _id: 'u1', name: 'Dave' })
    await adapter().getUser?.('tok')
    expect(port.setUsername).not.toHaveBeenCalled()
  })

  it('uses /me\'s id when the store has none', async () => {
    creds = { authToken: 'tok', userId: null }
    port.fetchMe.mockResolvedValue({ _id: 'from-me', name: 'Eve' })
    expect((await adapter().getUser?.('tok'))?.id).toBe('from-me')
  })

  it('throws rather than inventing an id when neither source has one', async () => {
    creds = { authToken: 'tok', userId: null }
    port.fetchMe.mockResolvedValue({ name: 'Ghost' })
    await expect(adapter().getUser?.('tok')).rejects.toThrow(/no user id/i)
  })

  it('throws when /me fails and the store has no id either', async () => {
    creds = { authToken: 'tok', userId: null }
    port.fetchMe.mockRejectedValue('not an error')
    await expect(adapter().getUser?.('tok')).rejects.toThrow(/no user id available/)
  })

  it('restores from the stored id when /me fails, logging the status only', async () => {
    port.fetchMe.mockRejectedValue(new Error('HTTP 401: {"email":"a@b.co"}'))
    expect(await adapter().getUser?.('tok')).toEqual({ id: 'user-1' })
    expect(log.warn).toHaveBeenCalledWith('[Auth] /me failed; restoring session from stored user id', { status: '401' })
  })

  it('logs a redacted error when /me fails without a status', async () => {
    port.fetchMe.mockRejectedValue(new Error('offline for a@b.co'))
    await adapter().getUser?.('tok')
    expect(log.warn.mock.calls[0][1]).toEqual({ error: 'Error: offline for [email]' })
  })
})

describe('admin-token guard (no privileged credential in the bundle)', () => {
  it.each(['adminToken', 'adminUserId', 'serviceToken'])('refuses %s', (key) => {
    expect(() => createRocketChatSessionAdapter({ port, [key]: 'x' } as never)).toThrow(/must stay on a server/)
  })
})

describe('defaultHttpStatusOf', () => {
  it('reads status, response.status, or HTTP <status> in the text', () => {
    expect(defaultHttpStatusOf({ status: 403 })).toBe('403')
    expect(defaultHttpStatusOf({ response: { status: 502 } })).toBe('502')
    expect(defaultHttpStatusOf(new Error('HTTP 404: nope'))).toBe('404')
    expect(defaultHttpStatusOf(new Error('offline'))).toBeNull()
  })
})

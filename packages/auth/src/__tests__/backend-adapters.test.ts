import { createOdooAdapter } from '../adapters/odoo'
import { createRocketChatAdapter } from '../adapters/rocketchat'

jest.mock('axios', () => {
  const instance = { get: jest.fn(), post: jest.fn() }
  return { __esModule: true, default: { create: jest.fn(() => instance) }, create: jest.fn(() => instance), __instance: instance }
})

const http = (jest.requireMock('axios') as { __instance: { get: jest.Mock, post: jest.Mock } }).__instance
const create = (jest.requireMock('axios') as { create: jest.Mock }).create
let log: Record<'debug' | 'info' | 'warn' | 'error', jest.Mock>

function decode(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
}

const ME = { _id: 'u1', username: 'alice', name: 'Alice', emails: [{ address: 'alice@x.com', verified: true }], status: 'online', roles: ['user'] }
const TOKEN = 'rcTok3nSECRETvalue0123456789abcdef'

beforeEach(() => {
  jest.clearAllMocks()
  log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
})

function secretsLogged(): boolean {
  return JSON.stringify(Object.values(log).map(m => m.mock.calls)).includes(TOKEN)
}

describe('createRocketChatAdapter', () => {
  const adapter = () => createRocketChatAdapter({ baseUrl: 'https://chat.example.test', logger: log })

  it('creates its client with the base URL and a 30 s default timeout', () => {
    adapter()
    expect(create).toHaveBeenCalledWith({ baseURL: 'https://chat.example.test', timeout: 30000, headers: { 'Content-Type': 'application/json' } })
  })

  it('logs in with email/password and wraps the RC token', async () => {
    http.post.mockResolvedValue({ data: { status: 'success', data: { userId: 'u1', authToken: TOKEN, me: ME } } })
    const tokens = await adapter().login({ email: 'alice@x.com', password: 'pw' })
    expect(http.post).toHaveBeenCalledWith('/api/v1/login', { user: 'alice@x.com', password: 'pw' })
    expect(tokens.refreshToken).toBe(TOKEN)
    expect(tokens.expiresIn).toBe(30 * 24 * 60 * 60)
    expect(tokens.accessToken.endsWith('.rc')).toBe(true)
    expect(decode(tokens.accessToken)).toMatchObject({ sub: 'u1', email: 'alice@x.com', auth_token: TOKEN })
  })

  it('logs in with a native OAuth token', async () => {
    http.post.mockResolvedValue({ data: { status: 'success', data: { userId: 'u1', authToken: TOKEN, me: ME } } })
    await adapter().login({ provider: 'google', token: 'id-tok', accessToken: 'acc', authorizationCode: 'code' })
    expect(http.post).toHaveBeenCalledWith('/api/v1/login', { serviceName: 'google', accessToken: 'id-tok', secret: 'acc', authorizationCode: 'code' })
  })

  it('rejects missing credentials and a failed login', async () => {
    await expect(adapter().login({})).rejects.toThrow('Invalid credentials')
    http.post.mockResolvedValue({ data: { status: 'error', message: 'Unauthorized' } })
    await expect(adapter().login({ email: 'a', password: 'b' })).rejects.toThrow('Unauthorized')
  })

  it('refreshes by verifying the token against /me', async () => {
    const a = adapter()
    http.post.mockResolvedValue({ data: { status: 'success', data: { userId: 'u1', authToken: TOKEN, me: ME } } })
    const { accessToken } = await a.login({ email: 'a', password: 'b' })
    http.get.mockResolvedValue({ data: ME })
    const tokens = await a.refresh(accessToken)
    expect(http.get).toHaveBeenCalledWith('/api/v1/me', { headers: { 'X-Auth-Token': TOKEN, 'X-User-Id': 'u1' } })
    expect(tokens.refreshToken).toBe(TOKEN)
    // A raw RC token works once the adapter knows the user id.
    await a.refresh(TOKEN)
    expect(http.get).toHaveBeenLastCalledWith('/api/v1/me', { headers: { 'X-Auth-Token': TOKEN, 'X-User-Id': 'u1' } })
  })

  it('expires the session when /me fails, without logging the token', async () => {
    await expect(adapter().refresh(TOKEN)).rejects.toThrow('Session expired')
    const a = adapter()
    http.post.mockResolvedValue({ data: { status: 'success', data: { userId: 'u1', authToken: TOKEN, me: ME } } })
    await a.login({ email: 'a', password: 'b' })
    http.get.mockRejectedValue(new Error(TOKEN))
    await expect(a.refresh(TOKEN)).rejects.toThrow('Session expired - please log in again')
    expect(log.warn).toHaveBeenCalledWith('[Auth] RocketChat session refresh failed', { error: 'Error: [redacted]' })
    expect(secretsLogged()).toBe(false)
  })

  it('revokes the token on the server at logout, and tolerates a failure', async () => {
    const a = adapter()
    http.post.mockResolvedValueOnce({ data: { status: 'success', data: { userId: 'u1', authToken: TOKEN, me: ME } } })
    await a.login({ email: 'a', password: 'b' })
    http.post.mockRejectedValueOnce(new Error('offline'))
    await expect(a.logout?.('x')).resolves.toBeUndefined()
    expect(http.post).toHaveBeenLastCalledWith('/api/v1/logout', {}, { headers: { 'X-Auth-Token': TOKEN, 'X-User-Id': 'u1' } })
    expect(log.warn).toHaveBeenCalledWith('[Auth] RocketChat server logout failed', { error: 'Error: offline' })
    // Signed out: a second logout makes no server call.
    http.post.mockClear()
    await a.logout?.('x')
    expect(http.post).not.toHaveBeenCalled()
  })

  it('refuses an admin token in its config', () => {
    expect(() => createRocketChatAdapter({ baseUrl: 'x', adminToken: 't' } as never)).toThrow(/must stay on a server/)
  })
})

describe('createOdooAdapter', () => {
  const adapter = () => createOdooAdapter({ baseUrl: 'https://erp.example.test', database: 'db1', timeout: 5000, logger: log })
  const SESSION = { uid: 7, session_id: 'sess-1', username: 'bob@x.com', name: 'Bob', partner_id: 3, company_id: 1 }

  it('creates a cookie-carrying client', () => {
    adapter()
    expect(create).toHaveBeenCalledWith({ baseURL: 'https://erp.example.test', timeout: 5000, headers: { 'Content-Type': 'application/json' }, withCredentials: true })
  })

  it('logs in over JSON-RPC and wraps the session', async () => {
    http.post.mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, result: SESSION } })
    const tokens = await adapter().login({ email: 'bob@x.com', password: 'pw' })
    expect(http.post).toHaveBeenCalledWith('/web/session/authenticate', expect.objectContaining({
      jsonrpc: '2.0',
      method: 'call',
      params: { db: 'db1', login: 'bob@x.com', password: 'pw' },
    }))
    expect(tokens.refreshToken).toBe('sess-1')
    expect(tokens.expiresIn).toBe(7 * 24 * 60 * 60)
    expect(tokens.accessToken.endsWith('.odoo')).toBe(true)
    expect(decode(tokens.accessToken)).toMatchObject({ sub: '7', email: 'bob@x.com', session_id: 'sess-1' })
  })

  it('rejects an RPC error and a session without uid', async () => {
    http.post.mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, error: { code: 200, message: 'Odoo Server Error', data: { name: 'x', debug: '', message: 'Access Denied' } } } })
    await expect(adapter().login({ email: 'a', password: 'b' })).rejects.toThrow('Access Denied')
    http.post.mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, result: { uid: 0 } } })
    await expect(adapter().login({ email: 'a', password: 'b' })).rejects.toThrow('Invalid credentials')
  })

  it('refreshes from the cookie session and expires when it is gone', async () => {
    http.post.mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, result: SESSION } })
    expect((await adapter().refresh('x')).refreshToken).toBe('sess-1')
    http.post.mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, result: {} } })
    await expect(adapter().refresh('x')).rejects.toThrow('Session expired - please log in again')
    expect(log.warn).toHaveBeenCalledWith('[Auth] Odoo session refresh failed', expect.any(Object))
  })

  it('destroys the server session at logout, and tolerates a failure', async () => {
    http.post.mockResolvedValue({ data: { jsonrpc: '2.0', id: 1, result: true } })
    await adapter().logout?.('x')
    expect(http.post).toHaveBeenCalledWith('/web/session/destroy', expect.any(Object))
    http.post.mockRejectedValue(new Error('offline'))
    await expect(adapter().logout?.('x')).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith('[Auth] Odoo server logout failed', { error: 'Error: offline' })
  })
})

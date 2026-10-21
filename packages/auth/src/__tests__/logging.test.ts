import type { AuthAdapter, AuthLogger } from '../types'
import { __resetSecureStore } from '../../__mocks__/expo-secure-store'
import { __reset as resetJwtDecode } from '../../__mocks__/jwt-decode'
import { createAuthClient } from '../auth-client'
import { describeError } from '../log'
import { __resetStoreModules } from '../secure-token-store'

function createLogger(): AuthLogger & { lines: Array<[string, string, unknown]> } {
  const lines: Array<[string, string, unknown]> = []
  const at = (level: string) => (message: string, data?: Record<string, unknown>) => {
    lines.push([level, message, data])
  }
  return { lines, debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
}

function adapter(overrides?: Partial<AuthAdapter>): AuthAdapter {
  return {
    login: jest.fn(async () => ({ accessToken: 'access-123', refreshToken: 'refresh-456', expiresIn: 3600 })),
    refresh: jest.fn(async () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 })),
    ...overrides,
  }
}

beforeEach(() => {
  __resetStoreModules()
  __resetSecureStore()
  resetJwtDecode()
})

describe('auth logging', () => {
  it('logs each status transition at info, and no token or user id anywhere', async () => {
    const logger = createLogger()
    const client = createAuthClient({ adapter: adapter(), logger })
    await client.signIn({ username: 'test', password: 'pass' })

    const transitions = logger.lines.filter(([, m]) => m === '[auth] state changed').map(([l, , d]) => [l, d])
    expect(transitions).toEqual([
      ['info', { from: 'idle', to: 'authenticating' }],
      ['info', { from: 'authenticating', to: 'authenticated' }],
    ])
    const dump = JSON.stringify(logger.lines)
    expect(dump).not.toContain('access-123')
    expect(dump).not.toContain('refresh-456')
    expect(dump).not.toContain('user-1')
    expect(dump).not.toContain('pass')
    client.destroy()
  })

  it('logs a refresh failure at error and a refresh success at info', async () => {
    const logger = createLogger()
    const client = createAuthClient({
      adapter: adapter({ refresh: jest.fn().mockRejectedValue(new Error('boom')) }),
      logger,
    })
    await client.signIn({})
    await expect(client.refreshToken()).rejects.toMatchObject({ code: 'REFRESH_FAILED' })
    expect(logger.lines).toContainEqual(['error', '[auth] token refresh failed, signing out', { error: 'REFRESH_FAILED: boom' }])
    client.destroy()

    const ok = createLogger()
    const client2 = createAuthClient({ adapter: adapter(), logger: ok })
    await client2.signIn({})
    await client2.refreshToken()
    expect(ok.lines).toContainEqual(['info', '[auth] token refresh succeeded', { rotatedRefreshToken: true }])
    client2.destroy()
  })

  it('logs invalid credentials at warn, other sign-in failures at error', async () => {
    const logger = createLogger()
    const client = createAuthClient({
      adapter: adapter({ login: jest.fn().mockRejectedValue(new Error('Invalid credentials')) }),
      logger,
    })
    await expect(client.signIn({})).rejects.toBeDefined()
    expect(logger.lines.find(([, m]) => m === '[auth] signIn failed')?.[0]).toBe('warn')
    client.destroy()

    const logger2 = createLogger()
    const client2 = createAuthClient({
      adapter: adapter({ login: jest.fn().mockRejectedValue(new Error('socket hang up')) }),
      logger: logger2,
    })
    await expect(client2.signIn({})).rejects.toBeDefined()
    expect(logger2.lines.find(([, m]) => m === '[auth] signIn failed')?.[0]).toBe('error')
    client2.destroy()
  })

  it('describeError redacts email-shaped text', () => {
    expect(describeError(new Error('no user jane@example.com'))).toBe('Error: no user [email]')
  })
})

import type { LogEntry, LogTransport } from '../types'
import { createLogger } from '../logger'

// Mock react-native Platform
jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}))

// Mock network-state (needed by WebhookTransport/OfflineQueue)
jest.mock('../network-state', () => ({
  getNetworkState: jest.fn(async () => ({
    isConnected: true,
    type: 'wifi',
    isInternetReachable: true,
  })),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}))

// Mock __DEV__
// @ts-expect-error global __DEV__
global.__DEV__ = true

describe('Logger', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('should create a logger instance with all methods', () => {
    const logger = createLogger({
      appVersion: '1.0.0',
      ringBuffer: true,
    })

    expect(logger.debug).toBeDefined()
    expect(logger.info).toBeDefined()
    expect(logger.warn).toBeDefined()
    expect(logger.error).toBeDefined()
    expect(logger.captureException).toBeDefined()
    expect(logger.setUser).toBeDefined()
    expect(logger.setScreen).toBeDefined()
    expect(logger.setContext).toBeDefined()
    expect(logger.getLogs).toBeDefined()
    expect(logger.exportLogs).toBeDefined()
    expect(logger.flush).toBeDefined()
    expect(logger.destroy).toBeDefined()

    logger.destroy()
  })

  it('should log entries to ring buffer and retrieve them', async () => {
    const logger = createLogger({
      appVersion: '1.0.0',
      ringBuffer: true,
    })

    logger.info('hello world')
    logger.warn('warning here')

    // Ring buffer send is async — wait for it
    await new Promise(r => setTimeout(r, 10))

    const entries = logger.getLogs()
    expect(entries).toHaveLength(2)
    expect(entries[0].message).toBe('warning here')
    expect(entries[1].message).toBe('hello world')

    await logger.destroy()
  })

  it('should filter by minimum level', async () => {
    const logger = createLogger({
      appVersion: '1.0.0',
      minLevel: 'warn',
      ringBuffer: true,
    })

    logger.debug('should be filtered')
    logger.info('should be filtered')
    logger.warn('should appear')
    logger.error('should appear')

    await new Promise(r => setTimeout(r, 10))

    const logs = logger.getLogs()
    expect(logs).toHaveLength(2)
    expect(logs.every(e => e.level === 'warn' || e.level === 'error')).toBe(true)

    await logger.destroy()
  })

  it('records error and captureException at the strictest minLevel', async () => {
    const logger = createLogger({ appVersion: '1.0.0', minLevel: 'error', ringBuffer: true })

    logger.warn('filtered')
    logger.error('kept')
    logger.captureException(new Error('boom'))
    // A non-Error from a JS catch still gets a message.
    logger.captureException('thrown string' as never)

    await new Promise(r => setTimeout(r, 10))
    expect(logger.getLogs().map(e => e.message)).toEqual(['thrown string', 'boom', 'kept'])
    await logger.destroy()
  })

  it('reports a failing transport once, to the other transports only', async () => {
    const send = jest.fn(async () => { throw new Error('sink down') })
    const logger = createLogger({
      appVersion: '1.0.0',
      ringBuffer: true,
      transports: [{ name: 'bad', send }],
    })

    logger.info('one')
    logger.info('two')
    await new Promise(r => setTimeout(r, 10))

    const reports = logger.getLogs().filter(e => e.message === '[Logger] transport send failed')
    expect(reports).toHaveLength(1)
    expect(reports[0].level).toBe('error')
    expect(reports[0].data).toEqual({ transport: 'bad', error: 'Error: sink down' })
    // The report itself was never sent to the failing transport.
    expect(send).toHaveBeenCalledTimes(2)
    await logger.destroy()
  })

  it('should route entries to custom transports', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [customTransport],
    })

    logger.info('custom transport test')

    await new Promise(r => setTimeout(r, 10))

    expect(sentEntries).toHaveLength(1)
    expect(sentEntries[0].message).toBe('custom transport test')

    await logger.destroy()
  })

  it('should support custom transport for Sentry-style breadcrumbs', async () => {
    const breadcrumbs: LogEntry[] = []
    const sentryTransport: LogTransport = {
      name: 'sentry-breadcrumbs',
      send: async (entries) => {
        for (const entry of entries) {
          if (entry.level === 'warn' || entry.level === 'error') {
            breadcrumbs.push(entry)
          }
        }
      },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [sentryTransport],
    })

    logger.info('info - no breadcrumb')
    logger.warn('warn - breadcrumb')
    logger.error('error - breadcrumb')

    await new Promise(r => setTimeout(r, 10))

    expect(breadcrumbs).toHaveLength(2)
    expect(breadcrumbs[0].level).toBe('warn')
    expect(breadcrumbs[1].level).toBe('error')

    await logger.destroy()
  })

  it('should call onException callback on captureException', async () => {
    const onException = jest.fn()
    const logger = createLogger({
      appVersion: '1.0.0',
      onException,
      ringBuffer: true,
    })

    const error = new Error('test error')
    logger.captureException(error, { extra: 'data' })

    expect(onException).toHaveBeenCalledTimes(1)
    expect(onException).toHaveBeenCalledWith(error, { extra: 'data' })

    await logger.destroy()
  })

  it('keeps an exception\'s own fields and cause, and context cannot overwrite its stack', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    const error = Object.assign(new Error('write failed'), { code: 'E_IO', status: 507, cause: new Error('disk full') })

    logger.captureException(error, { stack: 'not the stack', screen: 'sync' })

    const [entry] = logger.getLogs()
    expect(entry.message).toBe('write failed')
    expect(entry.data).toEqual(expect.objectContaining({
      name: 'Error',
      code: 'E_IO',
      status: 507,
      screen: 'sync',
      cause: expect.objectContaining({ message: 'disk full' }),
    }))
    expect(entry.data?.stack).not.toBe('not the stack')
    expect(entry.data?.stack).toEqual(expect.stringContaining('write failed'))
  })

  it('a transport that throws synchronously does not throw into the caller', () => {
    const logger = createLogger({
      appVersion: '1.0.0',
      ringBuffer: true,
      transports: [{ name: 'sync-thrower', send: () => {
        throw new Error('not a promise')
      } }],
    })
    expect(() => logger.info('still logged')).not.toThrow()
    expect(logger.getLogs().map(e => e.message)).toContain('still logged')
  })

  it('should log captureException as error entry with stack in data', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [customTransport],
    })

    const error = new Error('crash')
    logger.captureException(error, { userId: 'u1' })

    await new Promise(r => setTimeout(r, 10))

    expect(sentEntries).toHaveLength(1)
    expect(sentEntries[0].level).toBe('error')
    expect(sentEntries[0].message).toBe('crash')
    expect(sentEntries[0].data?.stack).toBeDefined()
    expect(sentEntries[0].data?.name).toBe('Error')
    expect(sentEntries[0].data?.userId).toBe('u1')

    await logger.destroy()
  })

  it('should include data parameter in log entries', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [customTransport],
    })

    logger.info('with data', { key: 'value', count: 42 })

    await new Promise(r => setTimeout(r, 10))

    expect(sentEntries[0].data).toEqual({ key: 'value', count: 42 })

    await logger.destroy()
  })

  it('should set user and include in context', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [customTransport],
    })

    logger.setUser('user-123')
    logger.info('after set user')

    await new Promise(r => setTimeout(r, 10))

    expect(sentEntries[0].context.userId).toBe('user-123')

    await logger.destroy()
  })

  it('should set screen and include in context', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [customTransport],
    })

    logger.setScreen('HomeScreen')
    logger.info('on home screen')

    await new Promise(r => setTimeout(r, 10))

    expect(sentEntries[0].context.screenName).toBe('HomeScreen')

    await logger.destroy()
  })

  it('should set extra context via setContext', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '1.0.0',
      transports: [customTransport],
    })

    logger.setContext('tenant', 'acme-corp')
    logger.info('with tenant')

    await new Promise(r => setTimeout(r, 10))

    const ctx = sentEntries[0].context as Record<string, unknown>
    expect(ctx.tenant).toBe('acme-corp')

    await logger.destroy()
  })

  it('should throw if getLogs called without ring buffer', () => {
    const logger = createLogger({
      appVersion: '1.0.0',
    })

    expect(() => logger.getLogs()).toThrow('Ring buffer not configured')

    logger.destroy()
  })

  it('should throw if exportLogs called without ring buffer', () => {
    const logger = createLogger({
      appVersion: '1.0.0',
    })

    expect(() => logger.exportLogs()).toThrow('Ring buffer not configured')

    logger.destroy()
  })

  it('should export logs as formatted JSON string', async () => {
    const logger = createLogger({
      appVersion: '1.0.0',
      ringBuffer: true,
    })

    logger.info('export test')

    await new Promise(r => setTimeout(r, 10))

    const json = logger.exportLogs()
    const parsed = JSON.parse(json)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed[0].message).toBe('export test')

    await logger.destroy()
  })

  it('should include appVersion and platform in context', async () => {
    const sentEntries: LogEntry[] = []
    const customTransport: LogTransport = {
      name: 'test',
      send: async (entries) => { sentEntries.push(...entries) },
    }

    const logger = createLogger({
      appVersion: '2.5.0',
      transports: [customTransport],
    })

    logger.info('version check')

    await new Promise(r => setTimeout(r, 10))

    expect(sentEntries[0].context.appVersion).toBe('2.5.0')
    expect(sentEntries[0].context.platform).toBe('ios')

    await logger.destroy()
  })
})

describe('Logger data is a JSON-safe snapshot', () => {
  it('exports an Error with its name, message, own fields and cause', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    const cause = new Error('disk full')
    const error = Object.assign(new Error('write failed', { cause }), { code: 'E_IO' })

    logger.error('flush failed', { error })

    const [entry] = JSON.parse(logger.exportLogs())
    expect(entry.data.error).toMatchObject({
      name: 'Error',
      message: 'write failed',
      code: 'E_IO',
      cause: { name: 'Error', message: 'disk full' },
    })
  })

  it('never lets a circular reference or a BigInt empty the export', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    const loop: Record<string, unknown> = { name: 'loop' }
    loop.self = loop

    logger.info('before')
    logger.info('bad', { loop, big: BigInt(10) })
    logger.info('after')

    const entries = JSON.parse(logger.exportLogs())
    expect(entries.map((e: { message: string }) => e.message)).toEqual(['after', 'bad', 'before'])
    expect(entries[1].data).toEqual({ loop: { name: 'loop', self: '[Circular]' }, big: '10' })
  })

  it('keeps the value as it was when logged, not as later mutated', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    const state = { phase: 'connecting' }

    logger.info('transition', { state })
    state.phase = 'ready'

    expect(logger.getLogs()[0].data).toEqual({ state: { phase: 'connecting' } })
  })

  it('does not mark a repeated (non-circular) object as circular', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    const shared = { id: 1 }

    logger.info('pair', { a: shared, b: shared })

    expect(logger.getLogs()[0].data).toEqual({ a: { id: 1 }, b: { id: 1 } })
  })
})

describe('Logger minLevel validation', () => {
  it('normalizes an upper-case level from env', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true, minLevel: 'INFO' as never })

    logger.debug('dropped')
    logger.info('kept')

    expect(logger.getLogs().map(e => e.message)).toEqual(['kept'])
  })

  it('falls back to the default for an unknown level instead of disabling filtering', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation()
    // __DEV__ is true here, so the default is 'debug' — the point is that
    // the logger filters by a real level rather than comparing to undefined.
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true, minLevel: 'verbose' as never })

    logger.debug('kept at the dev default')

    // Newest first.
    expect(logger.getLogs().map(e => e.message)).toEqual(['kept at the dev default', '[Logger] unknown minLevel; using the default'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown minLevel'), expect.anything())
  })

  it('reports an unknown level through the logger, so a release export shows it', () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true, minLevel: 'verbose' as never })
    const [entry] = logger.getLogs({ level: 'warn' })
    expect(entry?.message).toBe('[Logger] unknown minLevel; using the default')
    expect(entry?.data).toEqual({ configured: 'verbose', using: 'debug' })
  })
})

describe('Logger file export', () => {
  it('exports what the file transport kept', async () => {
    const logger = createLogger({ appVersion: '1.0.0', file: true })

    logger.info('persisted')
    const content = await logger.exportFileLogs()

    expect(content).toContain('"message":"persisted"')
  })

  it('rejects when no file transport is configured', async () => {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true })
    await expect(logger.exportFileLogs()).rejects.toThrow('File transport not configured')
  })
})

describe('Logger redaction and entry caps', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation()
    jest.spyOn(console, 'warn').mockImplementation()
    jest.spyOn(console, 'error').mockImplementation()
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  async function logged(config: Partial<Parameters<typeof createLogger>[0]>, write: (l: ReturnType<typeof createLogger>) => void) {
    const logger = createLogger({ appVersion: '1.0.0', ringBuffer: true, ...config })
    write(logger)
    await new Promise(r => setTimeout(r, 10))
    const logs = logger.getLogs()
    await logger.destroy()
    return logs
  }

  it('masks secret-looking keys and emails by default, in data and message', async () => {
    const [entry] = await logged({}, l => l.warn('no user foo@bar.com', {
      authToken: 'abc',
      nested: { Authorization: 'Bearer x', refresh_token: 'r', tokenCount: 3 },
      error: 'Error: login bob@example.org rejected',
      email: 'a@b.co',
      emailVerified: true,
    }))

    expect(entry.message).toBe('no user [email]')
    expect(entry.data).toEqual({
      authToken: '[redacted]',
      nested: { Authorization: '[redacted]', refresh_token: '[redacted]', tokenCount: 3 },
      error: 'Error: login [email] rejected',
      email: '[redacted]',
      emailVerified: true,
    })
  })

  it('redacts a captured exception message before it is stored', async () => {
    const [entry] = await logged({}, l => l.captureException(new Error('bad login x@y.io')))
    expect(entry.message).toBe('bad login [email]')
  })

  it('applies a custom redact hook, and `false` logs verbatim', async () => {
    const [custom] = await logged(
      { redact: e => ({ ...e, data: { ...e.data, userId: 'tail' } }) },
      l => l.info('x', { userId: 'u-123456', token: 't' }),
    )
    expect(custom.data).toEqual({ userId: 'tail', token: 't' })

    const [raw] = await logged({ redact: false }, l => l.info('a@b.co', { token: 't' }))
    expect(raw.message).toBe('a@b.co')
    expect(raw.data).toEqual({ token: 't' })
  })

  it('falls back to the default rules when the hook throws', async () => {
    const [entry] = await logged(
      { redact: () => { throw new Error('boom') } },
      l => l.info('x', { password: 'p' }),
    )
    expect(entry.data).toEqual({ password: '[redacted]', redactFailed: 'Error: boom' })
  })

  it('caps long strings, long arrays and the message', async () => {
    const readings = Array.from({ length: 120 }, (_, i) => i)
    const [entry] = await logged({}, l => l.info('m'.repeat(2500), { readings, body: 'b'.repeat(3000) }))

    expect(entry.message).toHaveLength(2000 + '…[+500 chars]'.length)
    const data = entry.data as { readings: unknown[], body: string }
    expect(data.readings).toHaveLength(51)
    expect(data.readings[50]).toBe('[+70 more]')
    expect(data.body.endsWith('…[+1000 chars]')).toBe(true)
  })

  it('keeps more of a stack than of an ordinary string', async () => {
    const error = new Error('e')
    error.stack = 's'.repeat(5000)
    const [entry] = await logged({}, l => l.error('failed', { error }))
    expect((entry.data as { error: { stack: string } }).error.stack).toHaveLength(5000)
  })
})

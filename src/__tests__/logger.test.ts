import { createLogger } from '../logger'
import type { LogEntry, LogTransport } from '../types'

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
    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

    const logs = logger.getLogs()
    expect(logs).toHaveLength(2)
    expect(logs.every((e) => e.level === 'warn' || e.level === 'error')).toBe(true)

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

    await new Promise((r) => setTimeout(r, 10))

    expect(sentEntries).toHaveLength(1)
    expect(sentEntries[0].message).toBe('custom transport test')

    await logger.destroy()
  })

  it('should call onLog callback for warn and error levels', async () => {
    const onLog = jest.fn()
    const logger = createLogger({
      appVersion: '1.0.0',
      onLog,
      ringBuffer: true,
    })

    logger.info('info - no callback')
    logger.warn('warn - callback')
    logger.error('error - callback')

    await new Promise((r) => setTimeout(r, 10))

    expect(onLog).toHaveBeenCalledTimes(2)
    expect(onLog.mock.calls[0][0].level).toBe('warn')
    expect(onLog.mock.calls[0][0].message).toBe('warn - callback')
    expect(onLog.mock.calls[1][0].level).toBe('error')

    await logger.destroy()
  })

  it('should support deprecated onError as fallback for onLog', async () => {
    const onError = jest.fn()
    const logger = createLogger({
      appVersion: '1.0.0',
      onError,
      ringBuffer: true,
    })

    logger.warn('via deprecated')

    await new Promise((r) => setTimeout(r, 10))

    expect(onError).toHaveBeenCalledTimes(1)

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

    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

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

    await new Promise((r) => setTimeout(r, 10))

    expect(sentEntries[0].context.appVersion).toBe('2.5.0')
    expect(sentEntries[0].context.platform).toBe('ios')

    await logger.destroy()
  })
})

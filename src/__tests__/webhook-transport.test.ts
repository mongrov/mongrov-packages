import { WebhookTransport } from '../transports/webhook'
import type { LogEntry, LogContext } from '../types'

// Mock network-state (needed by OfflineQueue)
jest.mock('../network-state', () => ({
  getNetworkState: jest.fn(async () => ({
    isConnected: true,
    type: 'wifi',
    isInternetReachable: true,
  })),
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
}))

// Mock react-native-mmkv (needed by OfflineQueue)
const mmkvData: Record<string, string> = {}
jest.mock('react-native-mmkv', () => {
  return {
    MMKV: jest.fn().mockImplementation(() => ({
      getString: (key: string) => mmkvData[key],
      set: (key: string, value: string) => { mmkvData[key] = value },
      delete: (key: string) => { delete mmkvData[key] },
    })),
  }
})

// Mock fetch
const mockFetch = jest.fn()
global.fetch = mockFetch

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  const context: LogContext = {
    sessionId: 'test-session',
    appVersion: '1.0.0',
    platform: 'ios',
  }
  return {
    id: `entry-${Math.random()}`,
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'test',
    context,
    ...overrides,
  }
}

describe('WebhookTransport', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.useFakeTimers()
    // Clear persisted queue between tests
    Object.keys(mmkvData).forEach((k) => delete mmkvData[k])
    mockFetch.mockResolvedValue({ ok: true, status: 200 })
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('should have the name "webhook"', () => {
    const transport = new WebhookTransport({ url: 'https://example.com/logs' })
    expect(transport.name).toBe('webhook')
    transport.destroy()
  })

  it('should batch entries and send when batchSize is reached', async () => {
    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 3,
    })

    await transport.send([makeEntry(), makeEntry(), makeEntry()])

    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]
    expect(url).toBe('https://example.com/logs')
    expect(options.method).toBe('POST')

    const body = JSON.parse(options.body)
    expect(body.entries).toHaveLength(3)

    await transport.destroy()
  })

  it('should flush batch on interval even if batchSize not reached', async () => {
    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 10,
      batchIntervalMs: 5000,
    })

    await transport.send([makeEntry()])
    expect(mockFetch).not.toHaveBeenCalled()

    jest.advanceTimersByTime(5000)
    // Give the interval callback a tick
    await Promise.resolve()

    expect(mockFetch).toHaveBeenCalledTimes(1)

    await transport.destroy()
  })

  it('should include custom headers', async () => {
    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 1,
      headers: { Authorization: 'Bearer token123' },
    })

    await transport.send([makeEntry()])

    const [, options] = mockFetch.mock.calls[0]
    expect(options.headers['Authorization']).toBe('Bearer token123')
    expect(options.headers['Content-Type']).toBe('application/json')

    await transport.destroy()
  })

  it('should use custom formatPayload', async () => {
    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 1,
      formatPayload: (entries) => ({
        text: entries.map((e) => e.message).join(', '),
      }),
    })

    await transport.send([makeEntry({ message: 'hello' })])

    const [, options] = mockFetch.mock.calls[0]
    const body = JSON.parse(options.body)
    expect(body.text).toBe('hello')

    await transport.destroy()
  })

  it('should drop entries on 4xx client error', async () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400 })

    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 1,
    })

    await transport.send([makeEntry()])

    // Should not throw and entries should be dropped (not re-queued)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    consoleSpy.mockRestore()
    await transport.destroy()
  })

  it('should delegate to offline queue on 5xx server error', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 })

    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 1,
    })

    await transport.send([makeEntry()])

    // The first call fails, entry goes to offline queue
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await transport.destroy()
  })

  it('should flush all pending entries on flush()', async () => {
    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 100, // High batch size so it doesn't auto-send
      batchIntervalMs: 60000, // Long interval so timer doesn't fire
    })

    await transport.send([makeEntry(), makeEntry()])
    expect(mockFetch).not.toHaveBeenCalled()

    await transport.flush()
    expect(mockFetch).toHaveBeenCalledTimes(1)

    await transport.destroy()
  })

  it('should flush remaining entries on destroy()', async () => {
    const transport = new WebhookTransport({
      url: 'https://example.com/logs',
      batchSize: 100,
    })

    await transport.send([makeEntry()])
    await transport.destroy()

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

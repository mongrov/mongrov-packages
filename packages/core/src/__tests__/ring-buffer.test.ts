import { RingBufferTransport } from '../transports/ring-buffer'
import type { LogEntry, LogContext } from '../types'

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  const context: LogContext = {
    sessionId: 'test-session',
    appVersion: '1.0.0',
    platform: 'ios',
  }
  return {
    id: `entry-${Date.now()}-${Math.random()}`,
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'test message',
    context,
    ...overrides,
  }
}

describe('RingBufferTransport', () => {
  let transport: RingBufferTransport

  beforeEach(() => {
    transport = new RingBufferTransport(5)
  })

  it('should have the name "ring-buffer"', () => {
    expect(transport.name).toBe('ring-buffer')
  })

  it('should store and retrieve entries', async () => {
    const entry = makeEntry({ message: 'hello' })
    await transport.send([entry])

    const entries = transport.getEntries()
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toBe('hello')
  })

  it('should return entries newest first', async () => {
    const e1 = makeEntry({ id: '1', message: 'first' })
    const e2 = makeEntry({ id: '2', message: 'second' })
    const e3 = makeEntry({ id: '3', message: 'third' })
    await transport.send([e1, e2, e3])

    const entries = transport.getEntries()
    expect(entries.map((e) => e.message)).toEqual(['third', 'second', 'first'])
  })

  it('should overwrite oldest entries when full (circular buffer)', async () => {
    const entries = Array.from({ length: 7 }, (_, i) =>
      makeEntry({ id: `${i}`, message: `msg-${i}` })
    )
    await transport.send(entries)

    const result = transport.getEntries()
    // Buffer size is 5, so only last 5 entries should remain
    expect(result).toHaveLength(5)
    expect(result.map((e) => e.message)).toEqual([
      'msg-6',
      'msg-5',
      'msg-4',
      'msg-3',
      'msg-2',
    ])
  })

  it('should filter by minimum level', async () => {
    await transport.send([
      makeEntry({ level: 'debug', message: 'debug-msg' }),
      makeEntry({ level: 'info', message: 'info-msg' }),
      makeEntry({ level: 'warn', message: 'warn-msg' }),
      makeEntry({ level: 'error', message: 'error-msg' }),
    ])

    const warnings = transport.getEntries({ level: 'warn' })
    expect(warnings).toHaveLength(2)
    expect(warnings.map((e) => e.level)).toEqual(['error', 'warn'])
  })

  it('should filter by time range (since)', async () => {
    const old = makeEntry({
      message: 'old',
      timestamp: '2024-01-01T00:00:00.000Z',
    })
    const recent = makeEntry({
      message: 'recent',
      timestamp: '2024-06-15T00:00:00.000Z',
    })
    await transport.send([old, recent])

    const result = transport.getEntries({
      since: new Date('2024-06-01T00:00:00.000Z'),
    })
    expect(result).toHaveLength(1)
    expect(result[0].message).toBe('recent')
  })

  it('should filter by message substring search', async () => {
    await transport.send([
      makeEntry({ message: 'User logged in' }),
      makeEntry({ message: 'API error occurred' }),
      makeEntry({ message: 'User logged out' }),
    ])

    const result = transport.getEntries({ search: 'logged' })
    expect(result).toHaveLength(2)
  })

  it('should filter search case-insensitively', async () => {
    await transport.send([makeEntry({ message: 'API Error' })])

    const result = transport.getEntries({ search: 'api error' })
    expect(result).toHaveLength(1)
  })

  it('should apply limit filter', async () => {
    await transport.send([
      makeEntry({ message: 'a' }),
      makeEntry({ message: 'b' }),
      makeEntry({ message: 'c' }),
    ])

    const result = transport.getEntries({ limit: 2 })
    expect(result).toHaveLength(2)
  })

  it('should combine multiple filters', async () => {
    await transport.send([
      makeEntry({ level: 'debug', message: 'debug API call' }),
      makeEntry({ level: 'error', message: 'API error' }),
      makeEntry({ level: 'error', message: 'disk error' }),
      makeEntry({ level: 'info', message: 'API success' }),
    ])

    const result = transport.getEntries({ level: 'error', search: 'API' })
    expect(result).toHaveLength(1)
    expect(result[0].message).toBe('API error')
  })

  it('should clear all entries', async () => {
    await transport.send([makeEntry(), makeEntry()])
    expect(transport.getEntries()).toHaveLength(2)

    transport.clear()
    expect(transport.getEntries()).toHaveLength(0)
  })

  it('should export entries as JSON string', async () => {
    const entry = makeEntry({ message: 'export-test' })
    await transport.send([entry])

    const json = transport.toJSON()
    const parsed = JSON.parse(json)
    expect(parsed).toHaveLength(1)
    expect(parsed[0].message).toBe('export-test')
  })

  it('should use default maxSize of 1000', () => {
    const defaultTransport = new RingBufferTransport()
    // We can't directly inspect maxSize, but we can verify it works with many entries
    const entries = Array.from({ length: 1001 }, (_, i) =>
      makeEntry({ id: `${i}`, message: `msg-${i}` })
    )
    defaultTransport.send(entries)

    const result = defaultTransport.getEntries()
    expect(result).toHaveLength(1000)
  })
})

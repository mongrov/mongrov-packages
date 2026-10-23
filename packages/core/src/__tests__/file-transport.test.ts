import type { LogContext, LogEntry } from '../types'
import { TextDecoder, TextEncoder } from 'node:util'

// Import the auto-mapped mock
import * as ExpoFileSystem from 'expo-file-system'
import { FileTransport, resetFileApiForTests } from '../transports/file'

// jsdom has no TextEncoder; Hermes (the app's runtime) does.
Object.assign(globalThis, { TextEncoder, TextDecoder })

const mockFs = ExpoFileSystem as unknown as {
  documentDirectory: string
  writeAsStringAsync: jest.Mock
  readAsStringAsync: jest.Mock
  readDirectoryAsync: jest.Mock
  getInfoAsync: jest.Mock
  deleteAsync: jest.Mock
  makeDirectoryAsync: jest.Mock
  __mockFiles: Record<string, string>
  __mockState: { noFileClass: boolean, appends: number }
}

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

function fakeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}

function clearMockFiles() {
  const files = mockFs.__mockFiles
  Object.keys(files).forEach(k => delete files[k])
}

// Only Date is faked, so a test can cross an hour boundary; timers and
// microtasks stay real for the write queue.
const REAL_EXCEPT_DATE = [
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'setImmediate',
  'clearImmediate',
  'nextTick',
  'queueMicrotask',
  'hrtime',
  'performance',
] as const

function fmtDay(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function hourName(d: Date = new Date(), seq = 0): string {
  return `logs-${fmtDay(d)}T${String(d.getUTCHours()).padStart(2, '0')}-${String(seq).padStart(3, '0')}.txt`
}

const DIR = '/mock/documents/logs/'
/** The file the current hour's first batch goes to. */
const currentPath = (seq = 0) => `${DIR}${hourName(new Date(), seq)}`

function linesOf(path: string): string[] {
  return mockFs.__mockFiles[path].trim().split('\n')
}

// Most of this suite runs on the read-and-rewrite fallback (expo-file-system
// before v19, no `File`); the append path has its own block at the end.
describe('FileTransport', () => {
  beforeEach(() => {
    clearMockFiles()
    jest.clearAllMocks()
    mockFs.__mockState.noFileClass = true
    mockFs.__mockState.appends = 0
    resetFileApiForTests()
  })

  it('should have the name "file"', () => {
    const transport = new FileTransport()
    expect(transport.name).toBe('file')
  })

  it('writes to the current hour\'s file', async () => {
    const transport = new FileTransport()
    await transport.send([makeEntry({ message: 'hello file' })])

    expect(mockFs.writeAsStringAsync).toHaveBeenCalled()
    expect(JSON.parse(mockFs.__mockFiles[currentPath()].trim()).message).toBe('hello file')
  })

  it('should append to existing file', async () => {
    const transport = new FileTransport()

    await transport.send([makeEntry({ message: 'first' })])
    await transport.send([makeEntry({ message: 'second' })])

    const lines = linesOf(currentPath())
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).message).toBe('first')
    expect(JSON.parse(lines[1]).message).toBe('second')
  })

  it('should write multiple entries in a single send', async () => {
    const transport = new FileTransport()
    await transport.send([
      makeEntry({ message: 'a' }),
      makeEntry({ message: 'b' }),
      makeEntry({ message: 'c' }),
    ])

    expect(linesOf(currentPath())).toHaveLength(3)
  })

  it('should use custom directory when provided', async () => {
    const transport = new FileTransport({ directory: '/custom/logs/' })
    await transport.send([makeEntry()])

    const paths = Object.keys(mockFs.__mockFiles)
    expect(paths.some(p => p.startsWith('/custom/logs/'))).toBe(true)
  })

  it('should ensure directory exists on first write', async () => {
    mockFs.getInfoAsync.mockImplementationOnce(async () => ({
      exists: false,
      size: 0,
      isDirectory: true,
    }))

    const transport = new FileTransport()
    await transport.send([makeEntry()])

    expect(mockFs.makeDirectoryAsync).toHaveBeenCalledWith(
      '/mock/documents/logs/',
      { intermediates: true },
    )
  })

  it('reports the fallback once, at info', async () => {
    const log = fakeLogger()
    const transport = new FileTransport(undefined, log)
    await transport.send([makeEntry()])
    await transport.send([makeEntry()])

    const fallback = log.info.mock.calls.filter(([m]) => String(m).includes('append API unavailable'))
    expect(fallback).toHaveLength(1)
  })

  it('should not crash on write failure', async () => {
    mockFs.writeAsStringAsync.mockRejectedValueOnce(new Error('disk full'))
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation()

    const transport = new FileTransport()
    await expect(transport.send([makeEntry()])).resolves.not.toThrow()

    consoleSpy.mockRestore()
  })

  it('reports a run of write failures once, then the recovery', async () => {
    const log = fakeLogger()
    mockFs.writeAsStringAsync
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))

    const transport = new FileTransport(undefined, log)
    await transport.send([makeEntry()])
    await transport.send([makeEntry()])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('write failed'),
      expect.objectContaining({ error: 'Error: disk full', lost: 1 }),
    )

    await transport.send([makeEntry()])
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('recovered'), { failedWrites: 2 })
  })

  it('should read a specific log file', async () => {
    mockFs.__mockFiles['/mock/documents/logs/logs-2024-06-01.txt']
      = '{"level":"info","message":"hello"}\n'

    const transport = new FileTransport()
    const content = await transport.readFile('logs-2024-06-01.txt')
    expect(content).toContain('"message":"hello"')
  })

  it('should serialize concurrent writes without data loss', async () => {
    const transport = new FileTransport()

    await Promise.all([
      transport.send([makeEntry({ message: 'a' })]),
      transport.send([makeEntry({ message: 'b' })]),
      transport.send([makeEntry({ message: 'c' })]),
      transport.send([makeEntry({ message: 'd' })]),
      transport.send([makeEntry({ message: 'e' })]),
    ])

    expect(linesOf(currentPath())).toHaveLength(5)
  })

  it('lists legacy and hourly files newest first', async () => {
    mockFs.__mockFiles[`${DIR}logs-2024-06-01.txt`] = 'data'
    mockFs.__mockFiles[`${DIR}logs-2024-06-02T00-000.txt`] = 'data'
    mockFs.__mockFiles[`${DIR}logs-2024-06-02.txt`] = 'data'

    const transport = new FileTransport()
    const files = await transport.getLogFiles()
    expect(files).toEqual(['logs-2024-06-02T00-000.txt', 'logs-2024-06-02.txt', 'logs-2024-06-01.txt'])
  })

  describe('batched writes', () => {
    it('coalesces lines sent during a write into one rewrite of the file', async () => {
      const transport = new FileTransport()

      await Promise.all(
        Array.from({ length: 50 }, (_, i) => transport.send([makeEntry({ message: `line ${i}` })])),
      )

      const lines = linesOf(currentPath())
      expect(lines).toHaveLength(50)
      expect(JSON.parse(lines[0]).message).toBe('line 0')
      expect(JSON.parse(lines[49]).message).toBe('line 49')
      // One write for the first line, one for the 49 that queued behind it.
      expect(mockFs.writeAsStringAsync.mock.calls.length).toBeLessThanOrEqual(2)
    })

    it('flush resolves once everything sent has been written', async () => {
      const transport = new FileTransport()
      void transport.send([makeEntry({ message: 'a' })])
      void transport.send([makeEntry({ message: 'b' })])

      await transport.flush()

      expect(linesOf(currentPath())).toHaveLength(2)
    })

    it('readAll returns legacy and hourly files oldest first, including pending lines', async () => {
      mockFs.__mockFiles[`${DIR}logs-2099-01-01T00-000.txt`] = 'future\n'
      const transport = new FileTransport({ retentionDays: 100_000 })
      mockFs.__mockFiles[`${DIR}logs-2000-01-01.txt`] = 'legacy-day\n'
      mockFs.__mockFiles[`${DIR}logs-2000-01-01T05-000.txt`] = 'same-day-hourly\n'
      void transport.send([makeEntry({ message: 'pending' })])

      const all = await transport.readAll()

      expect(all.indexOf('legacy-day')).toBeLessThan(all.indexOf('same-day-hourly'))
      expect(all.indexOf('same-day-hourly')).toBeLessThan(all.indexOf('pending'))
      expect(all.indexOf('pending')).toBeLessThan(all.indexOf('future'))
    })
  })

  describe('rotation', () => {
    afterEach(() => {
      jest.useRealTimers()
    })

    it('starts a new file at the UTC hour boundary', async () => {
      jest.useFakeTimers({ now: new Date('2026-10-22T09:59:58Z'), doNotFake: [...REAL_EXCEPT_DATE] })
      const transport = new FileTransport({ retentionDays: 100_000 })
      await transport.send([makeEntry({ message: 'before' })])
      jest.setSystemTime(new Date('2026-10-22T10:00:01Z'))
      await transport.send([makeEntry({ message: 'after' })])

      expect(mockFs.__mockFiles[`${DIR}logs-2026-10-22T09-000.txt`]).toContain('"before"')
      expect(mockFs.__mockFiles[`${DIR}logs-2026-10-22T10-000.txt`]).toContain('"after"')
      expect(mockFs.__mockFiles[`${DIR}logs-2026-10-22T10-000.txt`]).not.toContain('"before"')
    })

    it('starts the next NNN when the current file passes maxFileSizeKB; names sort in write order', async () => {
      const transport = new FileTransport({ maxFileSizeKB: 1 })
      const big = 'x'.repeat(600)
      for (let i = 0; i < 6; i++)
        await transport.send([makeEntry({ message: `${i}-${big}` })])

      const names = (await transport.getLogFiles()).reverse()
      expect(names.length).toBeGreaterThan(1)
      expect(names[0]).toBe(hourName(new Date(), 0))
      expect(names[1]).toBe(hourName(new Date(), 1))
      const all = await transport.readAll()
      const order = all.trim().split('\n').map(l => JSON.parse(l).message.split('-')[0])
      expect(order).toEqual(['0', '1', '2', '3', '4', '5'])
    })

    it('a relaunch continues the newest file of the hour, not a new one', async () => {
      mockFs.__mockFiles[currentPath(0)] = 'old\n'
      mockFs.__mockFiles[currentPath(1)] = 'earlier\n'
      const transport = new FileTransport()
      await transport.send([makeEntry({ message: 'resumed' })])

      expect(mockFs.__mockFiles[currentPath(1)]).toContain('"resumed"')
      expect(mockFs.__mockFiles[currentPath(2)]).toBeUndefined()
    })
  })

  describe('cleanup', () => {
    it('deletes legacy and hourly files beyond retention days', async () => {
      mockFs.__mockFiles[`${DIR}logs-2020-01-01.txt`] = '{"old":"data"}\n'
      mockFs.__mockFiles[`${DIR}logs-2020-01-02T03-000.txt`] = '{"old":"data"}\n'

      const transport = new FileTransport({ retentionDays: 7 })
      await transport.send([makeEntry()])

      expect(mockFs.__mockFiles[`${DIR}logs-2020-01-01.txt`]).toBeUndefined()
      expect(mockFs.__mockFiles[`${DIR}logs-2020-01-02T03-000.txt`]).toBeUndefined()
      expect(mockFs.__mockFiles[currentPath()]).toBeDefined()
    })

    it('deletes the oldest whole files when the directory passes maxSizeMB', async () => {
      const yesterday = new Date()
      yesterday.setUTCDate(yesterday.getUTCDate() - 1)
      const twoDaysAgo = new Date()
      twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2)
      const oldFile = `${DIR}logs-${fmtDay(twoDaysAgo)}.txt`
      const newFile = `${DIR}${hourName(yesterday)}`
      const bigContent = `${'x'.repeat(600_000)}\n`
      mockFs.__mockFiles[oldFile] = bigContent
      mockFs.__mockFiles[newFile] = bigContent

      const transport = new FileTransport({ maxSizeMB: 1 })
      await transport.send([makeEntry()])

      expect(mockFs.__mockFiles[oldFile]).toBeUndefined()
      expect(mockFs.__mockFiles[newFile]).toBe(bigContent)
    })

    it('never deletes or cuts the file being written, even alone over the cap', async () => {
      const old = 'x'.repeat(100)
      const existing = `${Array.from({ length: 20_000 }, (_, i) => `${old}${i}`).join('\n')}\n`
      mockFs.__mockFiles[currentPath()] = existing

      // maxFileSizeKB above the file, so the batch goes to the same file.
      const transport = new FileTransport({ maxSizeMB: 1, maxFileSizeKB: 10_000 })
      await transport.send([makeEntry({ message: 'newest' })])

      const content = mockFs.__mockFiles[currentPath()]
      expect(content.startsWith(existing)).toBe(true)
      expect(content).toContain('"message":"newest"')
      expect(mockFs.deleteAsync).not.toHaveBeenCalled()
    })
  })

  describe('append (expo-file-system v19+)', () => {
    beforeEach(() => {
      mockFs.__mockState.noFileClass = false
      resetFileApiForTests()
    })

    it('appends at the end of the file without reading or rewriting it', async () => {
      mockFs.__mockFiles[currentPath()] = 'earlier\n'
      const transport = new FileTransport()

      await transport.send([makeEntry({ message: 'first' })])
      await transport.send([makeEntry({ message: 'second' })])

      const lines = linesOf(currentPath())
      expect(lines[0]).toBe('earlier')
      expect(JSON.parse(lines[1]).message).toBe('first')
      expect(JSON.parse(lines[2]).message).toBe('second')
      expect(mockFs.readAsStringAsync).not.toHaveBeenCalled()
      expect(mockFs.writeAsStringAsync).not.toHaveBeenCalled()
    })

    it('n batches are n appends', async () => {
      const transport = new FileTransport()
      for (let i = 0; i < 7; i++)
        await transport.send([makeEntry({ message: `b${i}a` }), makeEntry({ message: `b${i}b` })])

      expect(mockFs.__mockState.appends).toBe(7)
      expect(linesOf(currentPath())).toHaveLength(14)
      expect(mockFs.readAsStringAsync).not.toHaveBeenCalled()
    })

    it('does not report a fallback', async () => {
      const log = fakeLogger()
      const transport = new FileTransport(undefined, log)
      await transport.send([makeEntry()])
      expect(log.info).not.toHaveBeenCalledWith(expect.stringContaining('append API unavailable'), expect.anything())
    })

    it('creates the file on the first write', async () => {
      const transport = new FileTransport()
      await transport.send([makeEntry({ message: 'hello' })])

      expect(JSON.parse(mockFs.__mockFiles[currentPath()].trim()).message).toBe('hello')
    })

    it('rotates by size on the bytes written', async () => {
      const transport = new FileTransport({ maxFileSizeKB: 1 })
      for (let i = 0; i < 4; i++)
        await transport.send([makeEntry({ message: 'x'.repeat(700) })])

      expect(mockFs.__mockFiles[currentPath(1)]).toBeDefined()
    })

    it('keeps multi-byte text intact', async () => {
      const transport = new FileTransport()
      await transport.send([makeEntry({ message: 'SpO₂ 97 % — ok' })])

      expect(JSON.parse(mockFs.__mockFiles[currentPath()].trim()).message).toBe('SpO₂ 97 % — ok')
    })

    it('a failing append is reported once and the next success recovers', async () => {
      const log = fakeLogger()
      const transport = new FileTransport(undefined, log)
      const realFile = (ExpoFileSystem as unknown as { File: new (u: string) => { open: () => unknown } }).File
      const openSpy = jest.spyOn(realFile.prototype, 'open')
        .mockImplementationOnce(() => { throw new Error('EIO') })
        .mockImplementationOnce(() => { throw new Error('EIO') })

      await transport.send([makeEntry()])
      await transport.send([makeEntry()])
      expect(log.error).toHaveBeenCalledTimes(1)
      await transport.send([makeEntry({ message: 'back' })])
      expect(log.info).toHaveBeenCalledWith(expect.stringContaining('recovered'), { failedWrites: 2 })
      expect(mockFs.__mockFiles[currentPath()]).toContain('"back"')
      openSpy.mockRestore()
    })
  })
})

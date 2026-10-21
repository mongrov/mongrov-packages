import type { LogContext, LogEntry } from '../types'
// Import the auto-mapped mock
import * as ExpoFileSystem from 'expo-file-system'

import { FileTransport } from '../transports/file'

const mockFs = ExpoFileSystem as unknown as {
  documentDirectory: string
  writeAsStringAsync: jest.Mock
  readAsStringAsync: jest.Mock
  readDirectoryAsync: jest.Mock
  getInfoAsync: jest.Mock
  deleteAsync: jest.Mock
  makeDirectoryAsync: jest.Mock
  __mockFiles: Record<string, string>
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

describe('FileTransport', () => {
  beforeEach(() => {
    clearMockFiles()
    jest.clearAllMocks()
  })

  it('should have the name "file"', () => {
    const transport = new FileTransport()
    expect(transport.name).toBe('file')
  })

  it('should create a daily log file', async () => {
    const transport = new FileTransport()
    const entry = makeEntry({ message: 'hello file' })
    await transport.send([entry])

    const today = new Date()
    const y = today.getUTCFullYear()
    const m = String(today.getUTCMonth() + 1).padStart(2, '0')
    const d = String(today.getUTCDate()).padStart(2, '0')
    const expectedFile = `/mock/documents/logs/logs-${y}-${m}-${d}.txt`

    expect(mockFs.writeAsStringAsync).toHaveBeenCalled()
    const writtenContent = mockFs.__mockFiles[expectedFile]
    expect(writtenContent).toBeDefined()
    const parsed = JSON.parse(writtenContent.trim())
    expect(parsed.message).toBe('hello file')
  })

  it('should append to existing file', async () => {
    const transport = new FileTransport()

    await transport.send([makeEntry({ message: 'first' })])
    await transport.send([makeEntry({ message: 'second' })])

    const today = new Date()
    const y = today.getUTCFullYear()
    const m = String(today.getUTCMonth() + 1).padStart(2, '0')
    const d = String(today.getUTCDate()).padStart(2, '0')
    const expectedFile = `/mock/documents/logs/logs-${y}-${m}-${d}.txt`

    const content = mockFs.__mockFiles[expectedFile]
    const lines = content.trim().split('\n')
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

    const today = new Date()
    const y = today.getUTCFullYear()
    const m = String(today.getUTCMonth() + 1).padStart(2, '0')
    const d = String(today.getUTCDate()).padStart(2, '0')
    const expectedFile = `/mock/documents/logs/logs-${y}-${m}-${d}.txt`

    const content = mockFs.__mockFiles[expectedFile]
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(3)
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

  it('should delete old files beyond retention days', async () => {
    mockFs.__mockFiles['/mock/documents/logs/logs-2020-01-01.txt'] = '{"old":"data"}\n'

    const transport = new FileTransport({ retentionDays: 7 })
    await transport.send([makeEntry()])

    expect(mockFs.deleteAsync).toHaveBeenCalledWith(
      '/mock/documents/logs/logs-2020-01-01.txt',
      { idempotent: true },
    )
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

  it('should delete oldest files when total size exceeds maxSizeMB', async () => {
    // Use recent dates so they don't get cleaned up by retention (default 7 days)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setUTCDate(yesterday.getUTCDate() - 1)
    const twoDaysAgo = new Date(today)
    twoDaysAgo.setUTCDate(twoDaysAgo.getUTCDate() - 2)

    const fmtDate = (d: Date) => {
      const y = d.getUTCFullYear()
      const m = String(d.getUTCMonth() + 1).padStart(2, '0')
      const day = String(d.getUTCDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }

    const oldFile = `/mock/documents/logs/logs-${fmtDate(twoDaysAgo)}.txt`
    const newFile = `/mock/documents/logs/logs-${fmtDate(yesterday)}.txt`

    // Create files whose total size exceeds 1 MB (using string length as byte size in mock)
    const bigContent = `${'x'.repeat(600_000)}\n` // ~600 KB each
    mockFs.__mockFiles[oldFile] = bigContent
    mockFs.__mockFiles[newFile] = bigContent

    // Total ~1.2 MB, set limit to 1 MB — oldest file should be deleted
    const transport = new FileTransport({ maxSizeMB: 1 })
    await transport.send([makeEntry()])

    // The oldest file should have been deleted to bring total under 1 MB
    expect(mockFs.deleteAsync).toHaveBeenCalledWith(
      oldFile,
      { idempotent: true },
    )
    // The newer file should still exist
    expect(mockFs.__mockFiles[newFile]).toBeDefined()
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

    // Fire 5 concurrent writes
    await Promise.all([
      transport.send([makeEntry({ message: 'a' })]),
      transport.send([makeEntry({ message: 'b' })]),
      transport.send([makeEntry({ message: 'c' })]),
      transport.send([makeEntry({ message: 'd' })]),
      transport.send([makeEntry({ message: 'e' })]),
    ])

    const today = new Date()
    const y = today.getUTCFullYear()
    const m = String(today.getUTCMonth() + 1).padStart(2, '0')
    const d = String(today.getUTCDate()).padStart(2, '0')
    const expectedFile = `/mock/documents/logs/logs-${y}-${m}-${d}.txt`

    const content = mockFs.__mockFiles[expectedFile]
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(5)
  })

  it('should list log files', async () => {
    mockFs.__mockFiles['/mock/documents/logs/logs-2024-06-01.txt'] = 'data'
    mockFs.__mockFiles['/mock/documents/logs/logs-2024-06-02.txt'] = 'data'

    const transport = new FileTransport()
    const files = await transport.getLogFiles()
    expect(files).toEqual(['logs-2024-06-02.txt', 'logs-2024-06-01.txt'])
  })

  describe('batched writes', () => {
    const todayPath = () => {
      const t = new Date()
      const y = t.getUTCFullYear()
      const m = String(t.getUTCMonth() + 1).padStart(2, '0')
      const d = String(t.getUTCDate()).padStart(2, '0')
      return `/mock/documents/logs/logs-${y}-${m}-${d}.txt`
    }

    it('coalesces lines sent during a write into one rewrite of the day file', async () => {
      const transport = new FileTransport()

      await Promise.all(
        Array.from({ length: 50 }, (_, i) => transport.send([makeEntry({ message: `line ${i}` })])),
      )

      const lines = mockFs.__mockFiles[todayPath()].trim().split('\n')
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

      expect(mockFs.__mockFiles[todayPath()].trim().split('\n')).toHaveLength(2)
    })

    it('never deletes today\'s file in size cleanup; trims its oldest lines instead', async () => {
      const old = 'x'.repeat(100)
      mockFs.__mockFiles[todayPath()] = `${Array.from({ length: 20_000 }, (_, i) => `${old}${i}`).join('\n')}\n`

      const transport = new FileTransport({ maxSizeMB: 1 })
      await transport.send([makeEntry({ message: 'newest' })])

      const content = mockFs.__mockFiles[todayPath()]
      expect(content).toBeDefined()
      expect(content.length).toBeLessThan(1024 * 1024)
      expect(content).toContain('"message":"newest"')
      expect(content).not.toContain(`${old}0\n`)
      expect(mockFs.deleteAsync).not.toHaveBeenCalledWith(todayPath(), expect.anything())
    })

    it('readAll returns every day file, oldest first, including pending lines', async () => {
      mockFs.__mockFiles['/mock/documents/logs/logs-2099-01-01.txt'] = 'future\n'
      const transport = new FileTransport({ retentionDays: 100_000 })
      mockFs.__mockFiles['/mock/documents/logs/logs-2000-01-01.txt'] = 'past\n'
      void transport.send([makeEntry({ message: 'pending' })])

      const all = await transport.readAll()

      expect(all.indexOf('past')).toBeLessThan(all.indexOf('pending'))
      expect(all.indexOf('pending')).toBeLessThan(all.indexOf('future'))
    })
  })
})

import { FileTransport } from '../transports/file'
import type { LogEntry, LogContext } from '../types'

// Import the auto-mapped mock
import * as ExpoFileSystem from 'expo-file-system'

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

function clearMockFiles() {
  const files = mockFs.__mockFiles
  Object.keys(files).forEach((k) => delete files[k])
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
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
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
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
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
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    const expectedFile = `/mock/documents/logs/logs-${y}-${m}-${d}.txt`

    const content = mockFs.__mockFiles[expectedFile]
    const lines = content.trim().split('\n')
    expect(lines).toHaveLength(3)
  })

  it('should use custom directory when provided', async () => {
    const transport = new FileTransport({ directory: '/custom/logs/' })
    await transport.send([makeEntry()])

    const paths = Object.keys(mockFs.__mockFiles)
    expect(paths.some((p) => p.startsWith('/custom/logs/'))).toBe(true)
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
      { intermediates: true }
    )
  })

  it('should delete old files beyond retention days', async () => {
    mockFs.__mockFiles['/mock/documents/logs/logs-2020-01-01.txt'] = '{"old":"data"}\n'

    const transport = new FileTransport({ retentionDays: 7 })
    await transport.send([makeEntry()])

    expect(mockFs.deleteAsync).toHaveBeenCalledWith(
      '/mock/documents/logs/logs-2020-01-01.txt',
      { idempotent: true }
    )
  })

  it('should not crash on write failure', async () => {
    mockFs.writeAsStringAsync.mockRejectedValueOnce(new Error('disk full'))
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()

    const transport = new FileTransport()
    await expect(transport.send([makeEntry()])).resolves.not.toThrow()

    consoleSpy.mockRestore()
  })

  it('should delete oldest files when total size exceeds maxSizeMB', async () => {
    // Use recent dates so they don't get cleaned up by retention (default 7 days)
    const today = new Date()
    const yesterday = new Date(today)
    yesterday.setDate(yesterday.getDate() - 1)
    const twoDaysAgo = new Date(today)
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2)

    const fmtDate = (d: Date) => {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }

    const oldFile = `/mock/documents/logs/logs-${fmtDate(twoDaysAgo)}.txt`
    const newFile = `/mock/documents/logs/logs-${fmtDate(yesterday)}.txt`

    // Create files whose total size exceeds 1 MB (using string length as byte size in mock)
    const bigContent = 'x'.repeat(600_000) + '\n' // ~600 KB each
    mockFs.__mockFiles[oldFile] = bigContent
    mockFs.__mockFiles[newFile] = bigContent

    // Total ~1.2 MB, set limit to 1 MB — oldest file should be deleted
    const transport = new FileTransport({ maxSizeMB: 1 })
    await transport.send([makeEntry()])

    // The oldest file should have been deleted to bring total under 1 MB
    expect(mockFs.deleteAsync).toHaveBeenCalledWith(
      oldFile,
      { idempotent: true }
    )
    // The newer file should still exist
    expect(mockFs.__mockFiles[newFile]).toBeDefined()
  })

  it('should read a specific log file', async () => {
    mockFs.__mockFiles['/mock/documents/logs/logs-2024-06-01.txt'] =
      '{"level":"info","message":"hello"}\n'

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
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
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
})

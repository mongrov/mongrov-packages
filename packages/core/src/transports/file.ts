import type { FileConfig, LogEntry, LogTransport } from '../types'

// expo-file-system types (imported dynamically to keep as peer dep)
interface FileSystem {
  documentDirectory: string | null
  writeAsStringAsync: (fileUri: string, contents: string, options?: { encoding?: string }) => Promise<void>
  readDirectoryAsync: (fileUri: string) => Promise<string[]>
  getInfoAsync: (fileUri: string) => Promise<{ exists: boolean, size?: number, isDirectory?: boolean }>
  deleteAsync: (fileUri: string, options?: { idempotent?: boolean }) => Promise<void>
  makeDirectoryAsync: (fileUri: string, options?: { intermediates?: boolean }) => Promise<void>
  readAsStringAsync: (fileUri: string) => Promise<string>
  EncodingType: { UTF8: string }
}

let FileSystemModule: FileSystem | null = null

function getFileSystem(): FileSystem {
  if (!FileSystemModule) {
    try {
      // Prefer the legacy subpath (expo-file-system v19+) to avoid deprecation warnings.
      // Falls back to the main entry for older versions.

      FileSystemModule = require('expo-file-system/legacy') as FileSystem
    }
    catch {
      try {
        FileSystemModule = require('expo-file-system') as FileSystem
      }
      catch {
        throw new Error(
          '@mongrov/core FileTransport requires expo-file-system as a peer dependency',
        )
      }
    }
  }
  return FileSystemModule
}

// UTC, the same clock as every entry's `timestamp`, so a file's name and the
// lines inside it agree on which day they belong to.
function formatDate(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function todayFilename(): string {
  return `logs-${formatDate(new Date())}.txt`
}

export class FileTransport implements LogTransport {
  readonly name = 'file'

  private readonly directory: string
  private readonly maxSizeMB: number
  private readonly retentionDays: number
  private initialized = false

  // Entries waiting for the next write, and the callers waiting on them.
  // expo-file-system has no append, so every write reads and rewrites the
  // whole day file. Writing once per `send` made that cost per log line — a
  // full ring sync logs hundreds of lines in seconds, each rewriting a file of
  // up to `maxSizeMB`. Lines that arrive while a write is in flight are
  // coalesced into the next one instead.
  private pending: LogEntry[] = []
  private pendingWaiters: Array<() => void> = []
  private writing: Promise<void> | null = null

  // Throttle cleanup to once per minute
  private lastCleanup = 0
  private readonly cleanupIntervalMs = 60_000

  constructor(config?: FileConfig) {
    const fs = getFileSystem()
    this.directory
      = config?.directory ?? `${fs.documentDirectory ?? ''}logs/`
    this.maxSizeMB = config?.maxSizeMB ?? 5
    this.retentionDays = config?.retentionDays ?? 7
  }

  /** Resolves once these entries are on disk (or the write failed). */
  send(entries: LogEntry[]): Promise<void> {
    this.pending.push(...entries)
    const done = new Promise<void>(resolve => this.pendingWaiters.push(resolve))
    if (!this.writing)
      this.writing = this.drain()
    return done
  }

  /** Resolves once everything sent so far has been written. */
  async flush(): Promise<void> {
    while (this.writing)
      await this.writing
  }

  private async drain(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending
      const waiters = this.pendingWaiters
      this.pending = []
      this.pendingWaiters = []
      await this.doWrite(batch)
      for (const resolve of waiters)
        resolve()
    }
    this.writing = null
  }

  private async doWrite(entries: LogEntry[]): Promise<void> {
    try {
      await this.ensureDirectory()

      const now = Date.now()
      if (now - this.lastCleanup >= this.cleanupIntervalMs) {
        await this.cleanupIfNeeded()
        this.lastCleanup = now
      }

      const lines = `${entries.map(e => JSON.stringify(e)).join('\n')}\n`
      const filePath = `${this.directory}${todayFilename()}`

      const fs = getFileSystem()
      const info = await fs.getInfoAsync(filePath)

      if (info.exists) {
        // Append by reading existing content + new lines
        const existing = await fs.readAsStringAsync(filePath)
        await fs.writeAsStringAsync(filePath, existing + lines)
      }
      else {
        await fs.writeAsStringAsync(filePath, lines)
      }
    }
    catch (error) {
      // Logging should never crash the app
      console.warn('[FileTransport] Write failed:', error)
    }
  }

  async getLogFiles(): Promise<string[]> {
    try {
      const fs = getFileSystem()
      const files = await fs.readDirectoryAsync(this.directory)
      return files
        .filter(f => f.startsWith('logs-') && f.endsWith('.txt'))
        .sort()
        .reverse()
    }
    catch {
      return []
    }
  }

  async readFile(filename: string): Promise<string> {
    const fs = getFileSystem()
    return fs.readAsStringAsync(`${this.directory}${filename}`)
  }

  /**
   * Every retained day file, oldest first: one JSON entry per line, oldest
   * line first. Unlike the ring buffer this survives an app restart or crash.
   * Waits for pending writes first, so the result includes everything sent.
   */
  async readAll(): Promise<string> {
    await this.flush()
    const files = (await this.getLogFiles()).reverse()
    let out = ''
    for (const file of files) {
      try {
        out += await this.readFile(file)
      }
      catch {
        // A file removed by cleanup mid-read is simply skipped.
      }
    }
    return out
  }

  private async ensureDirectory(): Promise<void> {
    if (this.initialized)
      return
    const fs = getFileSystem()
    const info = await fs.getInfoAsync(this.directory)
    if (!info.exists) {
      await fs.makeDirectoryAsync(this.directory, { intermediates: true })
    }
    this.initialized = true
  }

  private async cleanupIfNeeded(): Promise<void> {
    try {
      const fs = getFileSystem()
      const files = await fs.readDirectoryAsync(this.directory)
      const logFiles = files
        .filter(f => f.startsWith('logs-') && f.endsWith('.txt'))
        .sort()

      // Delete files older than retentionDays
      const cutoffDate = new Date()
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays)
      const cutoffStr = formatDate(cutoffDate)

      for (const file of logFiles) {
        const dateStr = file.replace('logs-', '').replace('.txt', '')
        if (dateStr < cutoffStr) {
          await fs.deleteAsync(`${this.directory}${file}`, { idempotent: true })
        }
      }

      // Check total size and delete oldest if exceeding maxSizeMB. Today's
      // file is never deleted — it holds the session being diagnosed. If it
      // alone is over the cap, its oldest lines are dropped instead.
      const today = todayFilename()
      let totalSize = 0
      const remaining = (await fs.readDirectoryAsync(this.directory))
        .filter(f => f.startsWith('logs-') && f.endsWith('.txt'))
        .sort()

      for (const file of remaining) {
        const info = await fs.getInfoAsync(`${this.directory}${file}`)
        totalSize += info.size ?? 0
      }

      const maxSizeBytes = this.maxSizeMB * 1024 * 1024
      const older = remaining.filter(f => f !== today)
      let i = 0
      while (totalSize > maxSizeBytes && i < older.length) {
        const file = older[i]
        const info = await fs.getInfoAsync(`${this.directory}${file}`)
        await fs.deleteAsync(`${this.directory}${file}`, { idempotent: true })
        totalSize -= info.size ?? 0
        i++
      }

      if (totalSize > maxSizeBytes && remaining.includes(today)) {
        const path = `${this.directory}${today}`
        const content = await fs.readAsStringAsync(path)
        // Keep the newest half of the cap, cut at a line boundary.
        const tail = content.slice(content.length - Math.floor(maxSizeBytes / 2))
        const firstBreak = tail.indexOf('\n')
        await fs.writeAsStringAsync(path, firstBreak >= 0 ? tail.slice(firstBreak + 1) : '')
      }
    }
    catch {
      // Cleanup failures are non-critical
    }
  }
}

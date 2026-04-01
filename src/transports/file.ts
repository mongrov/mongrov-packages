import type { LogEntry, LogTransport, FileConfig } from '../types'

// expo-file-system types (imported dynamically to keep as peer dep)
interface FileSystem {
  documentDirectory: string | null
  writeAsStringAsync(fileUri: string, contents: string, options?: { encoding?: string }): Promise<void>
  readDirectoryAsync(fileUri: string): Promise<string[]>
  getInfoAsync(fileUri: string): Promise<{ exists: boolean; size?: number; isDirectory?: boolean }>
  deleteAsync(fileUri: string, options?: { idempotent?: boolean }): Promise<void>
  makeDirectoryAsync(fileUri: string, options?: { intermediates?: boolean }): Promise<void>
  readAsStringAsync(fileUri: string): Promise<string>
  EncodingType: { UTF8: string }
}

let FileSystemModule: FileSystem | null = null

function getFileSystem(): FileSystem {
  if (!FileSystemModule) {
    try {
      // Prefer the legacy subpath (expo-file-system v19+) to avoid deprecation warnings.
      // Falls back to the main entry for older versions.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      FileSystemModule = require('expo-file-system/legacy') as FileSystem
    } catch {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        FileSystemModule = require('expo-file-system') as FileSystem
      } catch {
        throw new Error(
          '@mongrov/core FileTransport requires expo-file-system as a peer dependency'
        )
      }
    }
  }
  return FileSystemModule
}

function formatDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export class FileTransport implements LogTransport {
  readonly name = 'file'

  private readonly directory: string
  private readonly maxSizeMB: number
  private readonly retentionDays: number
  private initialized = false

  // Serial write queue to prevent concurrent read-then-write race conditions
  private writeChain: Promise<void> = Promise.resolve()

  // Throttle cleanup to once per minute
  private lastCleanup = 0
  private readonly cleanupIntervalMs = 60_000

  constructor(config?: FileConfig) {
    const fs = getFileSystem()
    this.directory =
      config?.directory ?? `${fs.documentDirectory ?? ''}logs/`
    this.maxSizeMB = config?.maxSizeMB ?? 5
    this.retentionDays = config?.retentionDays ?? 7
  }

  async send(entries: LogEntry[]): Promise<void> {
    // Chain writes to serialize file access
    const op = this.writeChain.then(() => this.doWrite(entries))
    this.writeChain = op.catch(() => {})
    return op
  }

  private async doWrite(entries: LogEntry[]): Promise<void> {
    try {
      await this.ensureDirectory()

      const now = Date.now()
      if (now - this.lastCleanup >= this.cleanupIntervalMs) {
        await this.cleanupIfNeeded()
        this.lastCleanup = now
      }

      const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
      const filename = `logs-${formatDate(new Date())}.txt`
      const filePath = `${this.directory}${filename}`

      const fs = getFileSystem()
      const info = await fs.getInfoAsync(filePath)

      if (info.exists) {
        // Append by reading existing content + new lines
        const existing = await fs.readAsStringAsync(filePath)
        await fs.writeAsStringAsync(filePath, existing + lines)
      } else {
        await fs.writeAsStringAsync(filePath, lines)
      }
    } catch (error) {
      // Logging should never crash the app
      console.warn('[FileTransport] Write failed:', error)
    }
  }

  async getLogFiles(): Promise<string[]> {
    try {
      const fs = getFileSystem()
      const files = await fs.readDirectoryAsync(this.directory)
      return files
        .filter((f) => f.startsWith('logs-') && f.endsWith('.txt'))
        .sort()
        .reverse()
    } catch {
      return []
    }
  }

  async readFile(filename: string): Promise<string> {
    const fs = getFileSystem()
    return fs.readAsStringAsync(`${this.directory}${filename}`)
  }

  private async ensureDirectory(): Promise<void> {
    if (this.initialized) return
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
        .filter((f) => f.startsWith('logs-') && f.endsWith('.txt'))
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

      // Check total size and delete oldest if exceeding maxSizeMB
      let totalSize = 0
      const remaining = (await fs.readDirectoryAsync(this.directory))
        .filter((f) => f.startsWith('logs-') && f.endsWith('.txt'))
        .sort()

      for (const file of remaining) {
        const info = await fs.getInfoAsync(`${this.directory}${file}`)
        totalSize += info.size ?? 0
      }

      const maxSizeBytes = this.maxSizeMB * 1024 * 1024
      let i = 0
      while (totalSize > maxSizeBytes && i < remaining.length) {
        const file = remaining[i]
        const info = await fs.getInfoAsync(`${this.directory}${file}`)
        await fs.deleteAsync(`${this.directory}${file}`, { idempotent: true })
        totalSize -= info.size ?? 0
        i++
      }
    } catch {
      // Cleanup failures are non-critical
    }
  }
}

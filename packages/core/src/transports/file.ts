import type { InternalLogger } from '../internal-log'
import type { FileConfig, LogEntry, LogTransport } from '../types'
import { devConsoleLogger, FailureGate } from '../internal-log'

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

// The object API (expo-file-system v19+). Its FileHandle writes at an offset,
// which is the only true append expo-file-system offers.
interface AppendFile {
  exists: boolean
  create: () => void
  open: () => { offset: number | null, size: number | null, writeBytes: (bytes: Uint8Array) => void, close: () => void }
}
type AppendFileCtor = new (uri: string) => AppendFile
type Utf8Encoder = new () => { encode: (text: string) => Uint8Array }

let AppendFileClass: AppendFileCtor | null | undefined

// Hermes provides it; core's tsconfig has no DOM lib to declare it.
function currentEncoder(): Utf8Encoder | undefined {
  return (globalThis as { TextEncoder?: Utf8Encoder }).TextEncoder
}

/** `null` on expo-file-system before v19 (no `File` / `Paths`), or without a TextEncoder. */
function getAppendFile(): AppendFileCtor | null {
  if (AppendFileClass === undefined) {
    try {
      const mod = require('expo-file-system') as { File?: AppendFileCtor, Paths?: unknown }
      AppendFileClass = typeof mod.File === 'function' && mod.Paths !== undefined && currentEncoder() ? mod.File : null
    }
    catch {
      AppendFileClass = null
    }
  }
  return AppendFileClass
}

/** Test seam: forget the probed API so the next write probes again. */
export function resetFileApiForTests(): void {
  AppendFileClass = undefined
}

// UTC, the same clock as every entry's `timestamp`, so a file's name and the
// lines inside it agree on which hour they belong to.
function formatDate(date: Date): string {
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function formatHour(date: Date): string {
  return `${formatDate(date)}T${String(date.getUTCHours()).padStart(2, '0')}`
}

/**
 * `logs-YYYY-MM-DDTHH-NNN.txt`: a new file every UTC hour, and a new `NNN`
 * when the current one passes `maxFileSizeKB`. Names sort chronologically,
 * and a pre-0.7 day file (`logs-YYYY-MM-DD.txt`) sorts before the same day's
 * hourly files (`.` < `T`), so legacy and new files read in one order.
 */
function rotatedName(hour: string, seq: number): string {
  return `logs-${hour}-${String(seq).padStart(3, '0')}.txt`
}

const ROTATED_RE = /^logs-(\d{4}-\d{2}-\d{2}T\d{2})-(\d{3,})\.txt$/
const DATE_RE = /^logs-(\d{4}-\d{2}-\d{2})/

function isLogFile(name: string): boolean {
  return name.startsWith('logs-') && name.endsWith('.txt')
}

/** The UTC day a log file belongs to, legacy or hourly; `null` if neither. */
function fileDay(name: string): string | null {
  return DATE_RE.exec(name)?.[1] ?? null
}

interface CurrentFile {
  hour: string
  seq: number
  name: string
  /** Bytes on disk, tracked so rotation needs no stat per batch. */
  size: number
}

export class FileTransport implements LogTransport {
  readonly name = 'file'

  private readonly directory: string
  private readonly maxSizeMB: number
  private readonly maxFileBytes: number
  private readonly retentionDays: number
  private readonly log: InternalLogger
  private readonly writeFailures = new FailureGate()
  private initialized = false
  private fallbackReported = false
  private current: CurrentFile | null = null

  // Entries waiting for the next write, and the callers waiting on them.
  // Lines that arrive while a write is in flight are coalesced into the next
  // one: one open (or one read+rewrite, on the fallback) per batch, not per
  // line.
  private pending: LogEntry[] = []
  private pendingWaiters: Array<() => void> = []
  private writing: Promise<void> | null = null

  // Throttle cleanup to once per minute
  private lastCleanup = 0
  private readonly cleanupIntervalMs = 60_000

  /**
   * `logger` receives this transport's own failures. `createLogger` passes
   * one that skips this transport; standalone use falls back to the dev
   * console.
   */
  constructor(config?: FileConfig, logger?: InternalLogger) {
    this.log = logger ?? devConsoleLogger()
    const fs = getFileSystem()
    this.directory
      = config?.directory ?? `${fs.documentDirectory ?? ''}logs/`
    this.maxSizeMB = config?.maxSizeMB ?? 5
    this.maxFileBytes = (config?.maxFileSizeKB ?? 1024) * 1024
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
      const target = await this.targetFile(new Date())

      const now = Date.now()
      if (now - this.lastCleanup >= this.cleanupIntervalMs) {
        await this.cleanupIfNeeded(target.name)
        this.lastCleanup = now
      }

      const lines = `${entries.map(e => JSON.stringify(e)).join('\n')}\n`
      target.size += await this.append(`${this.directory}${target.name}`, lines)
      const failed = this.writeFailures.recover()
      if (failed > 0)
        this.log.info('[FileTransport] writes recovered', { failedWrites: failed })
    }
    catch (error) {
      // Logging must never crash the app. The lines are lost from the file
      // (the ring buffer still has them); report once per run of failures.
      if (this.writeFailures.fail()) {
        this.log.error('[FileTransport] write failed; file log is missing lines', {
          error: String(error),
          lost: entries.length,
        })
      }
    }
  }

  /**
   * The file this batch goes to. A new UTC hour starts a new file; so does a
   * current file at or past `maxFileSizeKB`. On the first write of an hour
   * (a relaunch, say) it continues the newest file already on disk for that
   * hour, so a restart does not leave a run of near-empty files.
   */
  private async targetFile(at: Date): Promise<CurrentFile> {
    const hour = formatHour(at)
    if (this.current?.hour !== hour)
      this.current = await this.resumeHour(hour)
    if (this.current.size >= this.maxFileBytes) {
      const seq = this.current.seq + 1
      this.current = { hour, seq, name: rotatedName(hour, seq), size: 0 }
    }
    return this.current
  }

  private async resumeHour(hour: string): Promise<CurrentFile> {
    const fs = getFileSystem()
    const latest = (await fs.readDirectoryAsync(this.directory))
      .map(name => ROTATED_RE.exec(name))
      .filter((m): m is RegExpExecArray => m !== null && m[1] === hour)
      .map(m => Number(m[2]))
      .sort((a, b) => a - b)
      .pop()
    if (latest === undefined)
      return { hour, seq: 0, name: rotatedName(hour, 0), size: 0 }
    const name = rotatedName(hour, latest)
    const info = await fs.getInfoAsync(`${this.directory}${name}`)
    return { hour, seq: latest, name, size: info.size ?? 0 }
  }

  /**
   * Appends at the end of the file and returns the bytes written. Never reads
   * the file on the append path: a kill mid-write can at worst cut the last
   * line, not the lines already on disk.
   */
  private async append(filePath: string, lines: string): Promise<number> {
    const AppendFileCtor = getAppendFile()
    if (AppendFileCtor) {
      const bytes = new (currentEncoder() as Utf8Encoder)().encode(lines)
      const file = new AppendFileCtor(filePath)
      if (!file.exists)
        file.create()
      const handle = file.open()
      try {
        handle.offset = handle.size ?? 0
        handle.writeBytes(bytes)
      }
      finally {
        handle.close()
      }
      return bytes.length
    }
    if (!this.fallbackReported) {
      this.fallbackReported = true
      this.log.info('[FileTransport] append API unavailable; rewriting the file per batch', {
        reason: 'expo-file-system < 19 (no File / Paths) or no TextEncoder',
      })
    }
    const fs = getFileSystem()
    const info = await fs.getInfoAsync(filePath)
    if (info.exists) {
      const existing = await fs.readAsStringAsync(filePath)
      await fs.writeAsStringAsync(filePath, existing + lines)
    }
    else {
      await fs.writeAsStringAsync(filePath, lines)
    }
    return lines.length
  }

  /** Newest first. */
  async getLogFiles(): Promise<string[]> {
    try {
      const fs = getFileSystem()
      const files = await fs.readDirectoryAsync(this.directory)
      return files.filter(isLogFile).sort().reverse()
    }
    catch {
      // expected: no directory yet means no files have been written.
      return []
    }
  }

  async readFile(filename: string): Promise<string> {
    const fs = getFileSystem()
    return fs.readAsStringAsync(`${this.directory}${filename}`)
  }

  /**
   * Every retained file, legacy day files and hourly files together, oldest
   * first: one JSON entry per line, oldest line first. Unlike the ring buffer
   * this survives an app restart or crash. Waits for pending writes first, so
   * the result includes everything sent.
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

  /**
   * Deletes whole files only, never `current` (the file being written):
   * first those older than `retentionDays`, then the oldest until the
   * directory is under `maxSizeMB`. No file is ever cut, so every line left
   * on disk is a line as it was written.
   */
  private async cleanupIfNeeded(current: string): Promise<void> {
    try {
      const fs = getFileSystem()
      const files = (await fs.readDirectoryAsync(this.directory))
        .filter(isLogFile)
        .sort()

      const cutoffDate = new Date()
      cutoffDate.setUTCDate(cutoffDate.getUTCDate() - this.retentionDays)
      const cutoff = formatDate(cutoffDate)

      const kept: string[] = []
      for (const file of files) {
        const day = fileDay(file)
        if (file !== current && day !== null && day < cutoff)
          await fs.deleteAsync(`${this.directory}${file}`, { idempotent: true })
        else
          kept.push(file)
      }

      const sizes = new Map<string, number>()
      let totalSize = 0
      for (const file of kept) {
        const size = (await fs.getInfoAsync(`${this.directory}${file}`)).size ?? 0
        sizes.set(file, size)
        totalSize += size
      }

      const maxSizeBytes = this.maxSizeMB * 1024 * 1024
      for (const file of kept) {
        if (totalSize <= maxSizeBytes)
          break
        if (file === current)
          continue
        await fs.deleteAsync(`${this.directory}${file}`, { idempotent: true })
        totalSize -= sizes.get(file) ?? 0
      }
    }
    catch (error) {
      // Non-critical: the next cleanup (a minute on) tries again, but a
      // cleanup that keeps failing lets the log directory grow unbounded.
      this.log.warn('[FileTransport] cleanup failed', { error: String(error) })
    }
  }
}

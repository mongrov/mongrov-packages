import type { InternalLogger } from './internal-log'
import { devConsoleLogger, FailureGate } from './internal-log'

/**
 * A small file that says whether the last session ended cleanly.
 *
 * Written `running` when a logger starts and on every return to the
 * foreground, `backgrounded` when the app goes to the background, and
 * `closed` on `destroy()`. A file still saying `running` at the next start
 * means the process died in the foreground: a crash, an OOM kill, or a
 * watchdog. That is the one case a crash report may never have reached
 * Sentry, so it is logged as a warn with the previous session's id.
 *
 * `backgrounded` is NOT reported as unclean. iOS and Android reclaim
 * backgrounded apps routinely (iOS kills one a BLE sync woke within seconds),
 * so warning on every such end would bury the real crashes. It is logged at
 * info instead, distinguishably, so support can still see how a session ended.
 */

export type SessionState = 'running' | 'backgrounded' | 'closed'

export interface SessionRecord {
  sessionId: string
  startedAt: string
  state: SessionState
  /** When `state` last changed: the last moment the session is known alive. */
  updatedAt: string
  /** Set through `Logger.setLastCrashReportId` (e.g. a Sentry event id). */
  lastCrashReportId?: string
}

export interface PreviousSession {
  record: SessionRecord | null
  /** The file existed but did not parse. */
  unreadable: boolean
}

// The legacy string API: the marker is a few hundred bytes, rewritten whole.
interface MarkerFileSystem {
  documentDirectory: string | null
  writeAsStringAsync: (fileUri: string, contents: string) => Promise<void>
  readAsStringAsync: (fileUri: string) => Promise<string>
  getInfoAsync: (fileUri: string) => Promise<{ exists: boolean }>
  makeDirectoryAsync: (fileUri: string, options?: { intermediates?: boolean }) => Promise<void>
}

function loadFileSystem(): MarkerFileSystem {
  try {
    return require('expo-file-system/legacy') as MarkerFileSystem
  }
  catch {
    try {
      return require('expo-file-system') as MarkerFileSystem
    }
    catch {
      throw new Error('@mongrov/core sessionMarker requires expo-file-system as a peer dependency')
    }
  }
}

function isRecord(value: unknown): value is SessionRecord {
  if (value === null || typeof value !== 'object')
    return false
  const r = value as Record<string, unknown>
  return typeof r.sessionId === 'string'
    && typeof r.startedAt === 'string'
    && (r.state === 'running' || r.state === 'backgrounded' || r.state === 'closed')
}

/** Not the FileTransport's `logs-*.txt` shape, so its cleanup and export skip it. */
export const SESSION_MARKER_FILE = 'session-marker.json'

export class SessionMarker {
  private readonly fs: MarkerFileSystem
  private readonly directory: string
  private readonly path: string
  private readonly log: InternalLogger
  private readonly writeFailures = new FailureGate()
  private record: SessionRecord
  // Writes run one after another, in call order, so a fast background →
  // active flip can never land on disk as `backgrounded`.
  private queue: Promise<void> = Promise.resolve()

  /** Throws when expo-file-system is missing; the logger reports that once. */
  constructor(sessionId: string, directory: string | undefined, logger?: InternalLogger) {
    this.fs = loadFileSystem()
    this.directory = directory ?? `${this.fs.documentDirectory ?? ''}logs/`
    this.path = `${this.directory}${SESSION_MARKER_FILE}`
    this.log = logger ?? devConsoleLogger()
    const now = new Date().toISOString()
    this.record = { sessionId, startedAt: now, state: 'running', updatedAt: now }
  }

  /**
   * Reads what the previous session left, then marks this one `running`.
   * Never rejects: a failure is reported and the previous session is unknown.
   */
  async start(): Promise<PreviousSession> {
    let previous: PreviousSession = { record: null, unreadable: false }
    try {
      const info = await this.fs.getInfoAsync(this.path)
      if (info.exists) {
        const text = await this.fs.readAsStringAsync(this.path)
        let parsed: unknown
        try {
          parsed = JSON.parse(text)
        }
        catch {
          parsed = null
        }
        previous = isRecord(parsed) ? { record: parsed, unreadable: false } : { record: null, unreadable: true }
      }
    }
    catch (error) {
      this.failed('read', error)
    }
    await this.write()
    return previous
  }

  /** Records the state change; resolves once it is on disk (or failed). */
  mark(state: SessionState): Promise<void> {
    if (this.record.state === state)
      return this.queue
    this.record = { ...this.record, state, updatedAt: new Date().toISOString() }
    return this.write()
  }

  setLastCrashReportId(id: string): Promise<void> {
    this.record = { ...this.record, lastCrashReportId: id }
    return this.write()
  }

  private write(): Promise<void> {
    const snapshot = JSON.stringify(this.record)
    this.queue = this.queue.then(async () => {
      try {
        const dir = await this.fs.getInfoAsync(this.directory)
        if (!dir.exists)
          await this.fs.makeDirectoryAsync(this.directory, { intermediates: true })
        await this.fs.writeAsStringAsync(this.path, snapshot)
        const failed = this.writeFailures.recover()
        if (failed > 0)
          this.log.info('[Logger] session marker recovered', { failedWrites: failed })
      }
      catch (error) {
        this.failed('write', error)
      }
    })
    return this.queue
  }

  private failed(op: 'read' | 'write', error: unknown): void {
    if (this.writeFailures.fail())
      this.log.error('[Logger] session marker failed', { op, error: String(error) })
  }
}

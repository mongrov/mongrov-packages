export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  userId?: string
  sessionId: string
  screenName?: string
  appVersion: string
  updateId?: string
  platform: 'ios' | 'android'
  deviceId?: string
}

export interface LogEntry {
  id: string
  timestamp: string
  level: LogLevel
  message: string
  data?: Record<string, unknown>
  context: LogContext
}

export interface LogFilter {
  level?: LogLevel
  since?: Date
  search?: string
  limit?: number
}

export interface LogTransport {
  name: string
  send: (entries: LogEntry[]) => Promise<void>
}

export interface RingBufferConfig {
  maxSize?: number
}

export interface FileConfig {
  /** Total size of the log directory; the oldest whole files go first. Default 5. */
  maxSizeMB?: number
  /** A file past this starts the next one in the same hour. Default 1024. */
  maxFileSizeKB?: number
  retentionDays?: number
  directory?: string
}

export interface WebhookConfig {
  url: string
  headers?: Record<string, string>
  batchSize?: number
  batchIntervalMs?: number
  maxRetries?: number
  formatPayload?: (entries: LogEntry[]) => unknown
}

export interface LoggerConfig {
  minLevel?: LogLevel
  ringBuffer?: RingBufferConfig | boolean
  file?: FileConfig | boolean
  webhook?: WebhookConfig
  transports?: LogTransport[]
  appVersion: string
  updateId?: string
  onException?: (error: Error, context?: Record<string, unknown>) => void
  /**
   * Rewrites every entry before any transport sees it. Defaults to
   * `defaultRedact` (secret-looking keys and emails masked); compose with it
   * to add app rules, or pass `false` to log verbatim.
   */
  redact?: ((entry: LogEntry) => LogEntry) | false
  /**
   * Record whether the previous session ended cleanly (needs
   * expo-file-system). At start a previous session still marked `running`
   * (the process died in the foreground) is logged once at warn as
   * `logger.session.unclean-exit`; one that ended in the background is
   * logged at info. The marker lives next to the file logs (`file.directory`
   * when set). Default off: no file IO.
   */
  sessionMarker?: boolean
}

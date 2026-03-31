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
  send(entries: LogEntry[]): Promise<void>
}

export interface RingBufferConfig {
  maxSize?: number
}

export interface FileConfig {
  maxSizeMB?: number
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
  /** @deprecated Use `onLog` instead. */
  onError?: (entry: LogEntry) => void
  /** Called for every warn / error entry. Use for Sentry breadcrumbs, analytics, etc. */
  onLog?: (entry: LogEntry) => void
  onException?: (error: Error, context?: Record<string, unknown>) => void
}

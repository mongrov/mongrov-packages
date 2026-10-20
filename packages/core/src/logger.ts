import type {
  FileConfig,
  LogContext,
  LogEntry,
  LogFilter,
  LoggerConfig,
  LogLevel,
  LogTransport,
  RingBufferConfig,
} from './types'
import { FileTransport } from './transports/file'
import { RingBufferTransport } from './transports/ring-buffer'
import { WebhookTransport } from './transports/webhook'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && value in LEVEL_ORDER
}

/**
 * `minLevel` arrives from env in practice (`EXPO_PUBLIC_LOG_LEVEL`), where
 * `'INFO'` or a typo is easy. An unknown level used to index LEVEL_ORDER to
 * `undefined`, every comparison came out false, and nothing was filtered.
 */
function resolveMinLevel(configured: unknown, fallback: LogLevel): LogLevel {
  if (configured == null || configured === '')
    return fallback
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : configured
  if (isLogLevel(normalized))
    return normalized
  if (isDev())
    console.warn(`[Logger] unknown minLevel ${JSON.stringify(configured)}; using '${fallback}'`)
  return fallback
}

const MAX_DEPTH = 6
const MAX_CAUSE_DEPTH = 3

function serializeError(error: Error, seen: WeakSet<object>, depth: number, causeDepth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: error.message }
  if (error.stack)
    out.stack = error.stack
  // Own enumerable fields (`code`, `status`, ...) carry the useful detail on
  // native and DB errors.
  for (const [key, value] of Object.entries(error)) {
    if (!(key in out))
      out[key] = sanitizeValue(value, seen, depth + 1)
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause !== undefined) {
    out.cause = causeDepth >= MAX_CAUSE_DEPTH
      ? '[Cause depth exceeded]'
      : cause instanceof Error
        ? serializeError(cause, seen, depth + 1, causeDepth + 1)
        : sanitizeValue(cause, seen, depth + 1)
  }
  return out
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined)
    return value
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value
    case 'bigint':
      return value.toString()
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`
    case 'symbol':
      return value.toString()
  }
  const obj = value as object
  if (seen.has(obj))
    return '[Circular]'
  if (depth >= MAX_DEPTH)
    return '[Depth exceeded]'
  seen.add(obj)
  try {
    if (obj instanceof Error)
      return serializeError(obj, seen, depth, 0)
    if (obj instanceof Date)
      return Number.isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString()
    if (Array.isArray(obj))
      return obj.map(item => sanitizeValue(item, seen, depth + 1))
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(obj))
      out[key] = sanitizeValue(item, seen, depth + 1)
    return out
  }
  finally {
    // Only ancestors count as circular; the same object twice side by side
    // is a repeat, not a cycle.
    seen.delete(obj)
  }
}

/**
 * A JSON-safe snapshot of `data`, taken when the line is logged.
 *
 * Entries used to hold the caller's object by reference, so the export showed
 * whatever it had been mutated into later; an `Error` exported as `{}` (its
 * fields are non-enumerable); and one circular reference or BigInt made
 * `exportLogs` throw, which emptied the whole export.
 */
export function sanitizeLogData(data?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (data === undefined || data === null)
    return undefined
  try {
    const out = sanitizeValue(data, new WeakSet(), 0)
    return out !== null && typeof out === 'object' && !Array.isArray(out)
      ? out as Record<string, unknown>
      : { value: out }
  }
  catch (error) {
    return { unserializable: String(error) }
  }
}

function stringifyEntries(entries: LogEntry[]): string {
  try {
    return JSON.stringify(entries, null, 2)
  }
  catch {
    // Per entry, so one bad line cannot empty the export.
    const parts = entries.map((entry) => {
      try {
        return JSON.stringify(entry, null, 2)
      }
      catch (error) {
        return JSON.stringify({
          id: entry.id,
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          data: { unserializable: String(error) },
        }, null, 2)
      }
    })
    return `[\n${parts.join(',\n')}\n]`
  }
}

let counter = 0
function generateId(): string {
  return `${Date.now()}-${++counter}`
}

function generateSessionId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function getPlatform(): 'ios' | 'android' {
  try {
    const { Platform } = require('react-native')
    return Platform.OS === 'android' ? 'android' : 'ios'
  }
  catch {
    return 'ios'
  }
}

function isDev(): boolean {
  try {
    return typeof __DEV__ !== 'undefined' ? __DEV__ : false
  }
  catch {
    return false
  }
}

export interface Logger {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
  captureException: (error: Error, context?: Record<string, unknown>) => void

  setUser: (userId: string) => void
  setScreen: (screenName: string) => void
  setContext: (key: string, value: string) => void

  getLogs: (filter?: LogFilter) => LogEntry[]
  exportLogs: (filter?: LogFilter) => string
  /**
   * Every line the file transport has kept (all retained days, oldest first,
   * one JSON entry per line). Survives restarts and crashes, unlike the ring
   * buffer. Rejects when the file transport is not configured.
   */
  exportFileLogs: () => Promise<string>

  flush: () => Promise<void>
  destroy: () => Promise<void>
}

export function createLogger(config: LoggerConfig): Logger {
  const dev = isDev()
  const minLevel = resolveMinLevel(config.minLevel, dev ? 'debug' : 'info')
  const minLevelNum = LEVEL_ORDER[minLevel]

  const sessionId = generateSessionId()
  const platform = getPlatform()

  // Mutable context
  const ctx: LogContext = {
    sessionId,
    appVersion: config.appVersion,
    updateId: config.updateId,
    platform,
  }

  const extraContext: Record<string, string> = {}

  // Initialize transports
  const transports: LogTransport[] = []
  let ringBuffer: RingBufferTransport | null = null
  let fileTransport: FileTransport | null = null
  let webhookTransport: WebhookTransport | null = null

  // Ring buffer
  if (config.ringBuffer) {
    const rbConfig: RingBufferConfig
      = typeof config.ringBuffer === 'boolean' ? {} : config.ringBuffer
    ringBuffer = new RingBufferTransport(rbConfig.maxSize)
    transports.push(ringBuffer)
  }

  // File transport
  if (config.file) {
    const fileConfig: FileConfig
      = typeof config.file === 'boolean' ? {} : config.file
    try {
      fileTransport = new FileTransport(fileConfig)
      transports.push(fileTransport)
    }
    catch (error) {
      // expo-file-system missing: logging still works without the file.
      if (dev)
        console.warn('[Logger] file transport unavailable:', error)
    }
  }

  // Webhook transport
  if (config.webhook) {
    webhookTransport = new WebhookTransport(config.webhook)
    transports.push(webhookTransport)
  }

  // Custom transports
  if (config.transports) {
    transports.push(...config.transports)
  }

  function buildEntry(level: LogLevel, message: string, data?: Record<string, unknown>): LogEntry {
    return {
      id: generateId(),
      timestamp: new Date().toISOString(),
      level,
      message,
      data: sanitizeLogData(data),
      context: { ...ctx, ...extraContext } as unknown as LogContext,
    }
  }

  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minLevelNum)
      return

    const entry = buildEntry(level, message, data)

    // Console output in dev
    if (dev) {
      const consoleFn = level === 'error'
        ? console.error
        : level === 'warn'
          ? console.warn
          : level === 'debug'
            ? console.debug
            : console.log
      consoleFn(`[${level.toUpperCase()}] ${message}`, data ?? '')
    }

    // Route to all transports (non-blocking)
    for (const transport of transports) {
      transport.send([entry]).catch(() => {
        // Transport errors are non-fatal
      })
    }
  }

  const logger: Logger = {
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),

    captureException(error: Error, context?: Record<string, unknown>) {
      log('error', error.message, {
        stack: error.stack,
        name: error.name,
        ...context,
      })
      if (config.onException) {
        config.onException(error, context)
      }
    },

    setUser(userId: string) {
      ctx.userId = userId
    },

    setScreen(screenName: string) {
      ctx.screenName = screenName
    },

    setContext(key: string, value: string) {
      ;(extraContext as Record<string, string>)[key] = value
    },

    getLogs(filter?: LogFilter): LogEntry[] {
      if (!ringBuffer) {
        throw new Error('Ring buffer not configured. Enable ringBuffer in LoggerConfig.')
      }
      return ringBuffer.getEntries(filter)
    },

    exportLogs(filter?: LogFilter): string {
      if (!ringBuffer) {
        throw new Error('Ring buffer not configured. Enable ringBuffer in LoggerConfig.')
      }
      return stringifyEntries(ringBuffer.getEntries(filter))
    },

    async exportFileLogs() {
      if (!fileTransport) {
        throw new Error('File transport not configured. Enable file in LoggerConfig.')
      }
      return fileTransport.readAll()
    },

    async flush() {
      await fileTransport?.flush()
      if (webhookTransport) {
        await webhookTransport.flush()
      }
    },

    async destroy() {
      if (webhookTransport) {
        await webhookTransport.destroy()
      }
    },
  }

  return logger
}

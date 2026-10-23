import type { InternalLogger } from './internal-log'
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
import { FailureGate } from './internal-log'
import { defaultRedact } from './redact'
import { SessionMarker } from './session-marker'
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
function resolveMinLevel(configured: unknown, fallback: LogLevel): { level: LogLevel, unknown: boolean } {
  if (configured == null || configured === '')
    return { level: fallback, unknown: false }
  const normalized = typeof configured === 'string' ? configured.trim().toLowerCase() : configured
  if (isLogLevel(normalized))
    return { level: normalized, unknown: false }
  // Reported through the logger once it exists (below), so a bad
  // `EXPO_PUBLIC_LOG_LEVEL` in a release build is in the export, not lost.
  return { level: fallback, unknown: true }
}

const MAX_DEPTH = 6
const MAX_CAUSE_DEPTH = 3
// One logged readings array or document used to land in full in the file and
// the webhook. Entries are capped instead; the marker says how much was cut.
const MAX_STRING_LENGTH = 2000
const MAX_STACK_LENGTH = 8000
const MAX_ARRAY_ITEMS = 50

function capString(text: string, max = MAX_STRING_LENGTH): string {
  return text.length > max ? `${text.slice(0, max)}…[+${text.length - max} chars]` : text
}

function serializeError(error: Error, seen: WeakSet<object>, depth: number, causeDepth: number): Record<string, unknown> {
  const out: Record<string, unknown> = { name: error.name, message: capString(error.message) }
  if (error.stack)
    out.stack = capString(error.stack, MAX_STACK_LENGTH)
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
      return capString(value)
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
    if (Array.isArray(obj)) {
      const items = obj.slice(0, MAX_ARRAY_ITEMS).map(item => sanitizeValue(item, seen, depth + 1))
      if (obj.length > MAX_ARRAY_ITEMS)
        items.push(`[+${obj.length - MAX_ARRAY_ITEMS} more]`)
      return items
    }
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
  /** This logger's session; every entry carries it as `context.sessionId`. */
  readonly sessionId: string
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
  captureException: (error: Error, context?: Record<string, unknown>) => void

  setUser: (userId: string) => void
  setScreen: (screenName: string) => void
  setContext: (key: string, value: string) => void
  /**
   * The id of the last crash report the app sent (e.g. a Sentry event id),
   * kept in the session marker so the next start's
   * `logger.session.unclean-exit` can name it. No-op without `sessionMarker`.
   */
  setLastCrashReportId: (id: string) => void

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
  const { level: minLevel, unknown: minLevelUnknown } = resolveMinLevel(config.minLevel, dev ? 'debug' : 'info')
  const minLevelNum = LEVEL_ORDER[minLevel]

  const sessionId = generateSessionId()
  const platform = getPlatform()
  const redact = config.redact === false ? null : config.redact ?? defaultRedact

  // Mutable context
  const ctx: LogContext = {
    sessionId,
    appVersion: config.appVersion,
    updateId: config.updateId,
    platform,
  }

  const extraContext: Record<string, string> = {}

  // Per-transport failure runs, so a transport that rejects every entry
  // reports once rather than once per line.
  const sendFailures = new Map<string, FailureGate>()

  // Set while a core part's report is being routed. A report raised from
  // inside another report is dropped: core must never log about logging in
  // a loop.
  let reporting = false

  // Initialize transports
  const transports: LogTransport[] = []
  let ringBuffer: RingBufferTransport | null = null
  let fileTransport: FileTransport | null = null
  let webhookTransport: WebhookTransport | null = null
  let fileUnavailable: string | null = null

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
      fileTransport = new FileTransport(fileConfig, internalLogger('file'))
      transports.push(fileTransport)
    }
    catch (error) {
      // expo-file-system missing: logging still works without the file.
      // Reported once the other transports exist (below).
      fileUnavailable = String(error)
    }
  }

  // Webhook transport
  if (config.webhook) {
    webhookTransport = new WebhookTransport(config.webhook, internalLogger('webhook'))
    transports.push(webhookTransport)
  }

  // Custom transports
  if (config.transports) {
    transports.push(...config.transports)
  }

  if (fileUnavailable !== null)
    log('warn', '[Logger] file transport unavailable; file log disabled', { error: fileUnavailable })

  // Session marker: did the previous session end cleanly?
  let sessionMarker: SessionMarker | null = null
  let appStateSubscription: { remove: () => void } | null = null
  if (config.sessionMarker) {
    const fileConfig: FileConfig | undefined = typeof config.file === 'object' ? config.file : undefined
    try {
      sessionMarker = new SessionMarker(sessionId, fileConfig?.directory, internalLogger('session-marker'))
    }
    catch (error) {
      log('warn', '[Logger] session marker unavailable', { error: String(error) })
    }
  }
  if (sessionMarker) {
    const marker = sessionMarker
    marker.start().then(({ record, unreadable }) => {
      if (unreadable) {
        log('info', 'logger.session.marker-unreadable')
        return
      }
      if (!record || record.state === 'closed')
        return
      const previous = {
        previousSessionId: record.sessionId,
        startedAt: record.startedAt,
        lastSeenAt: record.updatedAt,
        lastCrashReportId: record.lastCrashReportId ?? null,
      }
      // Foreground death (crash, OOM, watchdog) is the case worth a warn; the
      // OS reclaiming a backgrounded app is routine, so it is info.
      if (record.state === 'running')
        log('warn', 'logger.session.unclean-exit', previous, true)
      else
        log('info', 'logger.session.ended-in-background', previous)
    })
    // Checkpoints follow the app's own lifecycle, so a logger created at
    // module load (before any provider) is covered too. `inactive` is a
    // transient iOS state (an incoming call, Control Centre) and is ignored.
    try {
      const { AppState } = require('react-native')
      if (AppState && typeof AppState.addEventListener === 'function') {
        appStateSubscription = AppState.addEventListener('change', (state: string) => {
          if (state === 'background')
            void marker.mark('backgrounded')
          else if (state === 'active')
            void marker.mark('running')
        })
      }
    }
    catch {
      // expected: no react-native (tests, node): the marker still records
      // start and destroy.
    }
  }
  if (minLevelUnknown)
    log('warn', '[Logger] unknown minLevel; using the default', { configured: String(config.minLevel), using: minLevel })

  function buildEntry(level: LogLevel, message: string, data?: Record<string, unknown>): LogEntry {
    const entry: LogEntry = {
      id: generateId(),
      timestamp: new Date().toISOString(),
      level,
      message: capString(String(message)),
      data: sanitizeLogData(data),
      context: { ...ctx, ...extraContext } as unknown as LogContext,
    }
    if (!redact)
      return entry
    try {
      return redact(entry)
    }
    catch (error) {
      // A throwing app hook must not leak the line it failed on, nor throw
      // into the caller: fall back to the default rules and say so.
      const safe = defaultRedact(entry)
      return { ...safe, data: { ...safe.data, redactFailed: String(error) } }
    }
  }

  function route(entry: LogEntry, skip?: string): void {
    for (const transport of transports) {
      if (transport.name === skip)
        continue
      // A custom transport that throws synchronously, or returns no promise,
      // must not throw into the caller of `logger.*`. Called synchronously
      // still: the ring buffer must hold the line by the time `log` returns.
      let sent: Promise<void>
      try {
        sent = Promise.resolve(transport.send([entry]))
      }
      catch (error) {
        sent = Promise.reject(error)
      }
      sent.then(
        () => {
          const failed = sendFailures.get(transport.name)?.recover() ?? 0
          if (failed > 0)
            report(transport.name, 'info', '[Logger] transport recovered', { transport: transport.name, failedSends: failed })
        },
        (error: unknown) => {
          let gate = sendFailures.get(transport.name)
          if (!gate) {
            gate = new FailureGate()
            sendFailures.set(transport.name, gate)
          }
          if (gate.fail())
            report(transport.name, 'error', '[Logger] transport send failed', { transport: transport.name, error: String(error) })
        },
      )
    }
  }

  function toConsole(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const consoleFn = level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : level === 'debug'
          ? console.debug
          : console.log
    consoleFn(`[${level.toUpperCase()}] ${message}`, data ?? '')
  }

  /**
   * `force` skips the `minLevel` filter. `error` is never filtered either:
   * it is the top level, and stays recorded whatever the config says.
   */
  function log(level: LogLevel, message: string, data?: Record<string, unknown>, force = false): void {
    if (!force && level !== 'error' && LEVEL_ORDER[level] < minLevelNum)
      return
    const entry = buildEntry(level, message, data)
    if (dev)
      toConsole(level, entry.message, entry.data)
    route(entry)
  }

  /** A report from core's own `source` transport: routed everywhere else. */
  function report(source: string, level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (reporting || LEVEL_ORDER[level] < minLevelNum)
      return
    reporting = true
    try {
      const entry = buildEntry(level, message, data)
      if (dev)
        toConsole(level, entry.message, entry.data)
      route(entry, source)
    }
    finally {
      reporting = false
    }
  }

  function internalLogger(source: string): InternalLogger {
    return {
      debug: (message, data) => report(source, 'debug', message, data),
      info: (message, data) => report(source, 'info', message, data),
      warn: (message, data) => report(source, 'warn', message, data),
      error: (message, data) => report(source, 'error', message, data),
    }
  }

  const logger: Logger = {
    sessionId,
    debug: (message, data) => log('debug', message, data),
    info: (message, data) => log('info', message, data),
    warn: (message, data) => log('warn', message, data),
    error: (message, data) => log('error', message, data),

    captureException(error: Error, context?: Record<string, unknown>) {
      // JS callers hand over whatever was thrown; a non-Error must not turn
      // into an `undefined` message.
      const err = error instanceof Error ? error : new Error(String(error))
      // The same serialization as any logged Error, so own fields (`code`,
      // `status`) and `cause` survive; it used to keep only stack and name.
      // The error's fields go last: a context key can no longer overwrite
      // `stack` or `name`. Recorded whatever `minLevel` says.
      const { name, stack, message: _message, ...detail } = serializeError(err, new WeakSet(), 0, 0)
      log('error', err.message, { ...context, ...detail, name, stack }, true)
      if (config.onException) {
        try {
          config.onException(err, context)
        }
        catch (hookError) {
          log('error', '[Logger] onException hook threw', { error: String(hookError) }, true)
        }
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

    setLastCrashReportId(id: string) {
      void sessionMarker?.setLastCrashReportId(id)
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
      appStateSubscription?.remove()
      appStateSubscription = null
      await sessionMarker?.mark('closed')
      if (webhookTransport) {
        await webhookTransport.destroy()
      }
    },
  }

  return logger
}

import type {
  LogLevel,
  LogEntry,
  LogFilter,
  LoggerConfig,
  LogContext,
  LogTransport,
  RingBufferConfig,
  FileConfig,
} from './types'
import { RingBufferTransport } from './transports/ring-buffer'
import { FileTransport } from './transports/file'
import { WebhookTransport } from './transports/webhook'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Platform } = require('react-native')
    return Platform.OS === 'android' ? 'android' : 'ios'
  } catch {
    return 'ios'
  }
}

function isDev(): boolean {
  try {
    return typeof __DEV__ !== 'undefined' ? __DEV__ : false
  } catch {
    return false
  }
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
  captureException(error: Error, context?: Record<string, unknown>): void

  setUser(userId: string): void
  setScreen(screenName: string): void
  setContext(key: string, value: string): void

  getLogs(filter?: LogFilter): LogEntry[]
  exportLogs(filter?: LogFilter): string

  flush(): Promise<void>
  destroy(): Promise<void>
}

export function createLogger(config: LoggerConfig): Logger {
  const dev = isDev()
  const minLevel = config.minLevel ?? (dev ? 'debug' : 'info')
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
  let webhookTransport: WebhookTransport | null = null

  // Ring buffer
  if (config.ringBuffer) {
    const rbConfig: RingBufferConfig =
      typeof config.ringBuffer === 'boolean' ? {} : config.ringBuffer
    ringBuffer = new RingBufferTransport(rbConfig.maxSize)
    transports.push(ringBuffer)
  }

  // File transport
  if (config.file) {
    const fileConfig: FileConfig =
      typeof config.file === 'boolean' ? {} : config.file
    transports.push(new FileTransport(fileConfig))
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
      data,
      context: { ...ctx, ...extraContext } as unknown as LogContext,
    }
  }

  function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < minLevelNum) return

    const entry = buildEntry(level, message, data)

    // Console output in dev
    if (dev) {
      const consoleFn = level === 'error' ? console.error
        : level === 'warn' ? console.warn
        : level === 'debug' ? console.debug
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
      const entries = ringBuffer.getEntries(filter)
      return JSON.stringify(entries, null, 2)
    },

    async flush() {
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

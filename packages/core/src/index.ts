// Context
export { LoggingProvider, useLogger } from './context/logging-provider'
// Internal reporting shape (transports, offline queue, network state)
export type { InternalLogger } from './internal-log'
// Logger
export { createLogger } from './logger'

export type { Logger } from './logger'
// Network (used internally, exported for convenience)
export { addNetworkStateListener, getNetworkState, setNetworkStateLogger, useNetworkState } from './network-state'

// Offline queue (exported for advanced usage)
export { OfflineQueue } from './offline-queue'
// Redaction (the default `LoggerConfig.redact`, for composing app rules)
export { defaultRedact, REDACTED } from './redact'
// Session marker (`LoggerConfig.sessionMarker`): how the previous session ended
export type { SessionRecord, SessionState } from './session-marker'
export { FileTransport } from './transports/file'

// Transports (for custom composition)
export { RingBufferTransport } from './transports/ring-buffer'

export { WebhookTransport } from './transports/webhook'

// Types
export type {
  FileConfig,
  LogContext,
  LogEntry,
  LogFilter,
  LoggerConfig,
  LogLevel,
  LogTransport,
  RingBufferConfig,
  WebhookConfig,
} from './types'

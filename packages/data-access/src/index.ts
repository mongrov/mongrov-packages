/**
 * Public barrel — @mongrov/data-access.
 *
 * v0.1.0-alpha.0 ships the API surface (types + stub functions). Runtime
 * behavior arrives in later tasks; every callable currently throws
 * NotImplementedError.
 */

export * from './context'
export * from './define'
export * from './dispatcher'
export * from './errors'
export * from './hooks'
// Query latency instrumentation (Sprint 5 T-45). Off by default — it exists
// to decide whether the analytics watermark cache is worth enabling.
export {
  createQueryInstrumentation,
  DEFAULT_MAX_SAMPLES,
  DEFAULT_WINDOW_MS,
  formatReport,
  WATERMARK_CACHE_GATE_MS,
} from './instrumentation'
export type {
  InstrumentationReport,
  QueryInstrumentation,
  QueryInstrumentationConfig,
  QueryLatencyStats,
} from './instrumentation'
export * from './invalidation'

export * from './tenant'
export * from './types'

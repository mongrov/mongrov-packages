import { NotImplementedError } from './errors'
import type { AnalyticsConfig, AnalyticsEngine } from './types'

/**
 * Wires config into engine + warehouse + machine.
 *
 * Stub in T-02. Full wiring lands in T-10 (Phase 4 — factory) once the
 * engine (T-03/04), warehouse (T-05/06/07/08), and machine (T-09) exist.
 */
export function createAnalytics(_config: AnalyticsConfig): AnalyticsEngine {
  throw new NotImplementedError('createAnalytics')
}

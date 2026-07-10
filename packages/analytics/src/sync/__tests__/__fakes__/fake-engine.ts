/**
 * Minimal HybridDuckDB stand-in for flusher tests.
 *
 * Captures appender calls so tests can assert on rows written; supports a
 * scripted `nextAppenderThrows` sequence for retry-path coverage.
 */

import type { DuckDBAppender, HybridDuckDB } from '../../../core/engine'

export interface FakeEngineHandle {
  engine: HybridDuckDB
  /** All rows written across every appender, tagged by table. */
  appended: Array<{ table: string, values: unknown[] }>
  /** Total flush() calls on appenders. */
  flushCount: number
  /** Total close() calls on appenders. */
  closeCount: number
  /** Queue error at the next appender open OR next flush. */
  queueOpenError: (err: Error) => void
  queueFlushError: (err: Error) => void
}

export function createFakeEngine(): FakeEngineHandle {
  const appended: Array<{ table: string, values: unknown[] }> = []
  const openErrors: Error[] = []
  const flushErrors: Error[] = []
  let flushCount = 0
  let closeCount = 0

  const engine = {
    createAppender(table: string): DuckDBAppender {
      const err = openErrors.shift()
      if (err) throw err
      return {
        appendRow(values: unknown[]) {
          appended.push({ table, values })
        },
        flush() {
          const ferr = flushErrors.shift()
          if (ferr) throw ferr
          flushCount += 1
        },
        close() {
          closeCount += 1
        },
      }
    },
  } as unknown as HybridDuckDB

  return {
    engine,
    appended,
    get flushCount() { return flushCount },
    get closeCount() { return closeCount },
    queueOpenError: err => openErrors.push(err),
    queueFlushError: err => flushErrors.push(err),
  }
}

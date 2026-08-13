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
  /** All execute() calls captured for SQL-path assertions. */
  executeCalls: Array<{ sql: string, params?: Record<string, unknown> }>
  /** Queue a canned row payload for the next execute() call. FIFO. */
  mockExecuteNext: (rows: unknown[]) => void
}

export function createFakeEngine(): FakeEngineHandle {
  const appended: Array<{ table: string, values: unknown[] }> = []
  const openErrors: Error[] = []
  const flushErrors: Error[] = []
  const executeCalls: Array<{ sql: string, params?: Record<string, unknown> }> = []
  const executeScript: unknown[][] = []
  let flushCount = 0
  let closeCount = 0

  const engine = {
    createAppender(table: string): DuckDBAppender {
      const err = openErrors.shift()
      if (err)
        throw err
      return {
        appendRow(values: unknown[]) {
          appended.push({ table, values })
        },
        flush() {
          const ferr = flushErrors.shift()
          if (ferr)
            throw ferr
          flushCount += 1
        },
        close() {
          closeCount += 1
        },
      }
    },
    async execute(sql: string, params?: Record<string, unknown>): Promise<unknown[]> {
      executeCalls.push({ sql, params })
      return executeScript.shift() ?? []
    },
  } as unknown as HybridDuckDB

  return {
    engine,
    appended,
    executeCalls,
    get flushCount() { return flushCount },
    get closeCount() { return closeCount },
    queueOpenError: err => openErrors.push(err),
    queueFlushError: err => flushErrors.push(err),
    mockExecuteNext: rows => executeScript.push(rows),
  }
}

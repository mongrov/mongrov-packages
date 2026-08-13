/**
 * SQL-focused fake engine for pusher / fetcher tests.
 *
 * Captures every `execute()` call (SQL text + bindings) and lets the test
 * script canned responses via `mockNext`.
 */

import type { HybridDuckDB } from '../../../core/engine'

export interface SqlCall {
  sql: string
  params?: Record<string, unknown>
}

export type ScriptedStep
  = | { type: 'rows', rows: unknown[] }
    | { type: 'throw', err: Error }

export interface FakeSqlEngine {
  engine: HybridDuckDB
  calls: SqlCall[]
  /** Queue a canned response for the next execute. FIFO. */
  mockNext: (rows: unknown[]) => void
  /** Queue an error to throw on the next execute. FIFO. */
  throwNext: (err: Error) => void
  /**
   * Route the next execute matching `sqlSubstr` to a specific step, ahead of
   * FIFO. Useful when parallel `Promise.allSettled` callers race.
   */
  mockWhen: (sqlSubstr: string, step: ScriptedStep) => void
}

export function createFakeSqlEngine(): FakeSqlEngine {
  const calls: SqlCall[] = []
  const script: ScriptedStep[] = []
  const targeted: Array<{ match: string, step: ScriptedStep }> = []
  const engine = {
    async execute(sql: string, params?: Record<string, unknown>): Promise<unknown[]> {
      calls.push({ sql, params })
      // Targeted matches first.
      const idx = targeted.findIndex(t => sql.includes(t.match))
      if (idx !== -1) {
        const [entry] = targeted.splice(idx, 1)
        if (entry!.step.type === 'throw')
          throw entry!.step.err
        return entry!.step.rows
      }
      const next = script.shift()
      if (!next)
        return []
      if (next.type === 'throw')
        throw next.err
      return next.rows
    },
  } as unknown as HybridDuckDB
  return {
    engine,
    calls,
    mockNext: rows => script.push({ type: 'rows', rows }),
    throwNext: err => script.push({ type: 'throw', err }),
    mockWhen: (sqlSubstr, step) => targeted.push({ match: sqlSubstr, step }),
  }
}

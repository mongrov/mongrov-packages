import type { AnalyticsEngine } from '../../core/types'

/**
 * Scriptable AnalyticsEngine fake for tool tests.
 *
 * Unlike the rules-side fake (single global queue), this fake supports
 * per-SQL-substring row queues so multi-query tools (compare, activity)
 * can script distinct responses per call.
 *
 * Usage:
 *   const engine = createFakeEngine()
 *   engine.queueRows('FROM hrv', [{ day: '2026-07-08', avg_hrv: 45 }])
 *   engine.queueRows('FROM sleep_session', [...])
 *   // ...invoke tool...
 *   engine.calls.forEach(c => ...)
 */
export interface FakeEngine extends AnalyticsEngine {
  readonly calls: { sql: string, params: Record<string, unknown> }[]
  queueRows: (sqlSubstring: string, rows: unknown[]) => void
  setError: (err: Error | null) => void
}

export function createFakeEngine(): FakeEngine {
  const queues: { substring: string, rows: unknown[] }[] = []
  const calls: { sql: string, params: Record<string, unknown> }[] = []
  let error: Error | null = null

  const engine: FakeEngine = {
    async attach() {},
    async detach() {},
    async execute<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
      calls.push({ sql, params: params ?? {} })
      if (error) throw error
      const idx = queues.findIndex(q => sql.includes(q.substring))
      if (idx === -1) return [] as T[]
      const [q] = queues.splice(idx, 1)
      return q.rows as T[]
    },
    stream<T>(): AsyncIterable<T[]> {
      throw new Error('stream not implemented in fake')
    },
    createAppender() {
      throw new Error('createAppender not implemented in fake')
    },
    state: 'attached',
    lastError: null,
    catalog: 'fake',
    mode: 'r2',
    subscribe: () => () => {},
    async setRetention() {},
    async getLastAttach() { return null },
    async close() {},
    calls,
    queueRows(substring, rows) { queues.push({ substring, rows }) },
    setError(err) { error = err },
  }
  return engine
}

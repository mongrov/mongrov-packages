import type { AnalyticsEngine } from '../../core/types'

/** Minimal AnalyticsEngine stub for evaluator tests. */
export interface FakeEngine extends AnalyticsEngine {
  __calls: { sql: string, params: Record<string, unknown> }[]
  __setResult(rows: unknown[]): void
  __setError(err: Error | null): void
}

export function createFakeEngine(): FakeEngine {
  let queued: unknown[] = []
  let queuedErr: Error | null = null
  const calls: { sql: string, params: Record<string, unknown> }[] = []

  const engine: FakeEngine = {
    async attach() {},
    async detach() {},
    async execute<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
      calls.push({ sql, params: params ?? {} })
      if (queuedErr) throw queuedErr
      return queued as T[]
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
    subscribe: () => () => {},
    async setRetention() {},
    async getLastAttach() { return null },
    async close() {},
    __calls: calls,
    __setResult(rows) { queued = rows; queuedErr = null },
    __setError(err) { queuedErr = err },
  }
  return engine
}

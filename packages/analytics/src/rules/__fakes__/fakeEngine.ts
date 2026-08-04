import type { AnalyticsEngine, AnalyticsState } from '../../core/types'

/** Minimal AnalyticsEngine stub for evaluator tests. */
export interface FakeEngine extends AnalyticsEngine {
  __calls: { sql: string, params: Record<string, unknown> }[]
  __setResult(rows: unknown[]): void
  __setError(err: Error | null): void
  /** Mutate the reported `state` for tests that exercise the attached-state guard. */
  __setState(state: AnalyticsState): void
  /** Seed the roster returned by `getFamilyMembers()`. */
  __setFamilyMembers(ids: string[]): void
}

export function createFakeEngine(): FakeEngine {
  let queued: unknown[] = []
  let queuedErr: Error | null = null
  let state: AnalyticsState = 'attached'
  let familyMembers: string[] = []
  const calls: { sql: string, params: Record<string, unknown> }[] = []

  const engine: FakeEngine = {
    async attach() {},
    async detach() {},
    async getFamilyMembers() { return familyMembers },
    async dismissInsight() {},
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
    get state() { return state },
    lastError: null,
    catalog: 'fake',
    mode: 'r2',
    subscribe: () => () => {},
    async setRetention() {},
    async getLastAttach() { return null },
    async close() {},
    __calls: calls,
    __setResult(rows) { queued = rows; queuedErr = null },
    __setError(err) { queuedErr = err },
    __setState(s) { state = s },
    __setFamilyMembers(ids) { familyMembers = ids },
  }
  return engine
}

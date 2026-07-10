/**
 * Minimal in-memory `AnalyticsEngine` for hook tests.
 *
 * Tests script:
 *   - the initial state (via `setState`)
 *   - `execute` results (via `setNextExecute` or `setExecuteImpl`)
 *   - `catalog` + `lastError` reads
 *
 * The fake keeps a set of subscribers and invokes them synchronously when
 * `setState` fires — hooks under test bind through
 * `useSyncExternalStore(engine.subscribe, () => engine.state)`.
 */

import type {
  AnalyticsAppender,
  AnalyticsEngine,
  AnalyticsState,
  AttachContext,
  Unsubscribe,
} from '../../types'

export interface FakeEngineHandle {
  engine: AnalyticsEngine
  setState(next: AnalyticsState): void
  setCatalog(next: string | undefined): void
  setLastError(err: Error | null): void
  setExecuteImpl(
    impl: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]>,
  ): void
  /** Every SQL sent via execute(), in order. */
  executeCalls: Array<{ sql: string, params?: Record<string, unknown> }>
}

export function createFakeEngine(initial: {
  state?: AnalyticsState
  catalog?: string
  execute?: (sql: string, params?: Record<string, unknown>) => Promise<unknown[]>
} = {}): FakeEngineHandle {
  let state: AnalyticsState = initial.state ?? 'ready'
  let catalog: string | undefined = initial.catalog
  let lastError: Error | null = null
  let executeImpl = initial.execute ?? (async () => [])
  const subscribers = new Set<(s: AnalyticsState) => void>()
  const executeCalls: FakeEngineHandle['executeCalls'] = []

  const engine: AnalyticsEngine = {
    async attach(_ctx: AttachContext) {
      // Tests drive attach via setState directly.
    },
    async detach() {},
    async execute<T = unknown>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
      executeCalls.push({ sql, params })
      const rows = await executeImpl(sql, params)
      return rows as T[]
    },
    // eslint-disable-next-line require-yield
    async *stream<T = unknown>(_sql: string, _params?: Record<string, unknown>): AsyncIterable<T[]> {
      return
    },
    createAppender(_table: string): AnalyticsAppender {
      return {
        appendRow() {},
        flush() {},
        close() {},
      }
    },
    get state() {
      return state
    },
    get lastError() {
      return lastError
    },
    get catalog() {
      return catalog
    },
    subscribe(listener): Unsubscribe {
      subscribers.add(listener)
      return () => subscribers.delete(listener) as unknown as void
    },
    async setRetention() {},
    async getLastAttach() {
      return null
    },
    async close() {
      subscribers.clear()
    },
  }

  return {
    engine,
    setState(next) {
      state = next
      for (const sub of subscribers) sub(next)
    },
    setCatalog(next) {
      catalog = next
    },
    setLastError(err) {
      lastError = err
    },
    setExecuteImpl(impl) {
      executeImpl = impl
    },
    executeCalls,
  }
}

import { describe, expect, it } from 'vitest'

import {
  AnalyticsError,
  createAnalytics,
  NotImplementedError,
  useAnalytics,
  useInsight,
  useTimeseries,
} from '../index'
import type {
  AnalyticsAppender,
  AnalyticsConfig,
  AnalyticsEngine,
  AnalyticsErrorCode,
  AnalyticsLogger,
  AnalyticsState,
  AttachContext,
  EventBus,
  FamilyMembersProvider,
  Insight,
  KVStore,
  TenantScope,
  TokenContext,
  TokenResponse,
  TokenVendor,
  Unsubscribe,
} from '../index'

/**
 * T-02 AC: `createAnalytics`, `useAnalytics`, `useTimeseries`, `useInsight`
 * exported from root; typed public surface exported; `createAnalytics({...})`
 * throws `NotImplementedError`.
 *
 * Types are asserted via a type-only reference below; runtime asserts each
 * stub throws the expected error class.
 */

// Compile-time surface — asserts each type is present + assignable to `unknown`.
// If any name goes missing from the barrel, this file stops compiling.
type _TypeSurface = {
  AnalyticsAppender: AnalyticsAppender
  AnalyticsConfig: AnalyticsConfig
  AnalyticsEngine: AnalyticsEngine
  AnalyticsErrorCode: AnalyticsErrorCode
  AnalyticsLogger: AnalyticsLogger
  AnalyticsState: AnalyticsState
  AttachContext: AttachContext
  EventBus: EventBus
  FamilyMembersProvider: FamilyMembersProvider
  Insight: Insight
  KVStore: KVStore
  TenantScope: TenantScope
  TokenContext: TokenContext
  TokenResponse: TokenResponse
  TokenVendor: TokenVendor
  Unsubscribe: Unsubscribe
}

describe('@mongrov/analytics public API surface', () => {
  it('createAnalytics is exported and throws NotImplementedError', () => {
    // Minimal config to satisfy the type — stubs throw before touching config.
    const config = {} as unknown as AnalyticsConfig
    expect(() => createAnalytics(config)).toThrow(NotImplementedError)
  })

  it('createAnalytics error surfaces the stubbed symbol name', () => {
    try {
      createAnalytics({} as unknown as AnalyticsConfig)
    } catch (err) {
      expect(err).toBeInstanceOf(NotImplementedError)
      expect(err).toBeInstanceOf(AnalyticsError)
      expect((err as AnalyticsError).code).toBe('not_implemented')
      expect((err as Error).message).toContain('createAnalytics')
    }
  })

  it('useAnalytics stub throws NotImplementedError', () => {
    expect(() => useAnalytics()).toThrow(NotImplementedError)
  })

  it('useTimeseries stub throws NotImplementedError', () => {
    expect(() => useTimeseries<{ v: number }>(undefined, 'SELECT 1')).toThrow(
      NotImplementedError
    )
  })

  it('useInsight stub throws NotImplementedError', () => {
    expect(() => useInsight('insight-id')).toThrow(NotImplementedError)
  })
})

describe('AnalyticsError taxonomy', () => {
  it('carries code + preserves cause', () => {
    const cause = new Error('root')
    const err = new AnalyticsError('query_failed', 'boom', cause)
    expect(err).toBeInstanceOf(AnalyticsError)
    expect(err.code).toBe('query_failed')
    expect(err.cause).toBe(cause)
    expect(err.name).toBe('AnalyticsError')
  })

  it('NotImplementedError specializes AnalyticsError', () => {
    const err = new NotImplementedError('someFn')
    expect(err).toBeInstanceOf(AnalyticsError)
    expect(err).toBeInstanceOf(NotImplementedError)
    expect(err.code).toBe('not_implemented')
    expect(err.name).toBe('NotImplementedError')
    expect(err.message).toContain('someFn')
  })
})

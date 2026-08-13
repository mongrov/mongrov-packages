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

import { describe, expect, it } from 'vitest'
import {
  AnalyticsError,
  createAnalytics,
  NotImplementedError,
  useAnalytics,
  useInsight,
  useTimeseries,
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
  it('createAnalytics is exported as a function', () => {
    // T-10: `createAnalytics` now returns a real engine wired to the state
    // machine. Runtime behaviour is asserted in `core/__tests__/factory.test.ts`;
    // here we only assert the export lives on the barrel.
    expect(typeof createAnalytics).toBe('function')
  })

  it('useAnalytics is exported as a function', () => {
    // T-11: real implementation. Runtime behaviour asserted in
    // `core/__tests__/hooks.test.tsx`; here we only verify the barrel.
    expect(typeof useAnalytics).toBe('function')
  })

  it('useTimeseries is exported as a function', () => {
    // T-12: real implementation. See `core/__tests__/hooks.test.tsx`.
    expect(typeof useTimeseries).toBe('function')
  })

  it('useInsight is exported as a function', () => {
    // T-13: real implementation. See `core/__tests__/hooks.test.tsx`.
    expect(typeof useInsight).toBe('function')
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

  it('accepts the full Phase 7 code taxonomy', () => {
    const codes: AnalyticsErrorCode[] = [
      'engine_open_failed',
      'extension_load_failed',
      'attach_failed',
      'detach_failed',
      'token_vendor_failed',
      'migration_failed',
      'retention_failed',
      'query_failed',
      'not_attached',
      'not_ready',
      'not_implemented',
    ]
    for (const code of codes) {
      const err = new AnalyticsError(code, `${code} test`)
      expect(err.code).toBe(code)
    }
  })
})

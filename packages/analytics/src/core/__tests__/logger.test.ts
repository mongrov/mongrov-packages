import { describe, expect, it, vi } from 'vitest'

import { noopLogger, resolveLogger } from '../logger'
import type { AnalyticsLogger } from '../types'

describe('noopLogger', () => {
  it('returns an AnalyticsLogger whose methods do not throw', () => {
    const log = noopLogger()

    expect(() => log.debug('x')).not.toThrow()
    expect(() => log.info('x', { k: 1 })).not.toThrow()
    expect(() => log.warn('x')).not.toThrow()
    expect(() => log.error('x', { cause: new Error('nope') })).not.toThrow()
  })

  it('returns undefined from every method (no-op contract)', () => {
    const log = noopLogger()
    expect(log.debug('m')).toBeUndefined()
    expect(log.info('m')).toBeUndefined()
    expect(log.warn('m')).toBeUndefined()
    expect(log.error('m')).toBeUndefined()
  })
})

describe('resolveLogger', () => {
  it('returns the provided logger when supplied', () => {
    const provided: AnalyticsLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const resolved = resolveLogger(provided)
    resolved.debug('hi')
    expect(provided.debug).toHaveBeenCalledWith('hi')
  })

  it('falls back to a no-op when logger is undefined', () => {
    const resolved = resolveLogger(undefined)
    expect(typeof resolved.debug).toBe('function')
    expect(typeof resolved.info).toBe('function')
    expect(typeof resolved.warn).toBe('function')
    expect(typeof resolved.error).toBe('function')
    expect(() => resolved.warn('anything')).not.toThrow()
  })
})

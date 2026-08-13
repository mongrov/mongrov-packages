/**
 * `describeError` exists because the logs it feeds were unusable.
 *
 * Every catch in this package logged `(err as Error).message`. When the thing
 * being logged is an `AnalyticsError`, that message is the wrapper's own text
 * and the real DuckDB error — the binder message, the offending column, the
 * SQL position — lives in `.cause` and never reached the log. zivaone_app#70
 * is exactly that: four rules reported "execute failed" and nothing else, so
 * the root cause could not be read off the report at all.
 *
 * The assertions below are about that: the deepest frame must survive.
 */
import { describe, expect, it } from 'vitest'

import { AnalyticsError, describeError } from '../errors'

describe('describeError', () => {
  it('keeps the underlying cause of a wrapped AnalyticsError', () => {
    const duck = new Error(
      'Binder Error: Referenced column "spo2" not found in FROM clause!',
    )
    const wrapped = new AnalyticsError('query_failed', 'execute failed', duck)

    const out = describeError(wrapped)

    // The wrapper alone is what the old code logged, and it says nothing.
    expect(out).toContain('execute failed')
    expect(out).toContain('query_failed')
    // This is the part that used to be lost.
    expect(out).toContain('Referenced column "spo2" not found')
  })

  it('walks a multi-level chain deepest-last', () => {
    const root = new Error('connection reset')
    const mid = new AnalyticsError('attach_failed', 'attach failed', root)
    const top = new AnalyticsError('query_failed', 'execute failed', mid)

    expect(describeError(top)).toBe(
      'AnalyticsError [query_failed]: execute failed'
      + ' <- caused by AnalyticsError [attach_failed]: attach failed'
      + ' <- caused by Error: connection reset',
    )
  })

  it('renders a non-Error cause instead of [object Object]', () => {
    // react-native-duckdb rejects with plain objects in some paths, and that
    // frame is usually the one carrying the detail.
    const wrapped = new AnalyticsError('query_failed', 'execute failed', {
      toString: () => 'DuckDBError(code=42P01)',
    })

    expect(describeError(wrapped)).toContain('DuckDBError(code=42P01)')
  })

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a') as Error & { cause?: unknown }
    const b = new Error('b') as Error & { cause?: unknown }
    a.cause = b
    b.cause = a

    const out = describeError(a)

    expect(out).toBe('Error: a <- caused by Error: b')
  })

  it('handles a bare string and a bare Error', () => {
    expect(describeError('boom')).toBe('boom')
    expect(describeError(new Error('boom'))).toBe('Error: boom')
  })
})

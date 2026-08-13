/**
 * Sprint 5 T-24 — baseline reader with day-first on-read fallback.
 *
 * The property that matters: stored and on-read paths must agree. If the
 * fallback quantiled raw readings while the scheduled job quantiled daily
 * values, the same rule would fire or not depending purely on whether a
 * sync cycle had happened yet.
 */

import { describe, expect, it, vi } from 'vitest'

import { buildBaselineSql } from '../../sync/baseline-compute'
import { createBaselineReader } from '../baseline-reader'

const CTX = { brand: 'ziva', familyId: 'fam1' }

const STORED = {
  p05: 92,
  p10: 93,
  p50: 96,
  p90: 98,
  p95: 99,
  mean: 96,
  stddev: 1.5,
  sample_count: 28,
}

/** Engine stub: separate scripts for the stored read and the on-read compute. */
function engineWith(opts: {
  stored?: Record<string, unknown> | null
  computed?: Record<string, unknown> | null
  throwOn?: 'stored'
}) {
  const calls: { sql: string, params: Record<string, unknown> }[] = []
  return {
    calls,
    engine: {
      async execute(sql: string, params?: Record<string, unknown>) {
        calls.push({ sql, params: params ?? {} })
        if (sql.includes('FROM user_baseline')) {
          if (opts.throwOn === 'stored')
            throw new Error('table missing')
          return opts.stored ? [opts.stored] : []
        }
        return opts.computed ? [opts.computed] : []
      },
    },
  }
}

describe('stored path', () => {
  it('reads user_baseline scoped to the tenant + metric + window', async () => {
    const { engine, calls } = engineWith({ stored: STORED })
    const reader = createBaselineReader({ analytics: engine as never })

    const b = await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(b).toMatchObject({ p10: 93, p50: 96, sampleCount: 28, computedOnRead: false })
    expect(calls[0].sql).toContain('FROM user_baseline')
    expect(calls[0].params).toMatchObject({
      brand: 'ziva',
      familyId: 'fam1',
      userId: 'alice',
      metric: 'spo2',
      windowDays: 30,
    })
  })

  it('rejects a stored row below the 20-day minimum', async () => {
    // Guards against a row written by an older, buggier compute.
    const { engine } = engineWith({
      stored: { ...STORED, sample_count: 15 },
      computed: null,
    })
    const reader = createBaselineReader({ analytics: engine as never })
    expect(await reader.getBaseline('alice', 'spo2', 30, CTX)).toBeNull()
  })
})

describe('on-read fallback', () => {
  it('computes when no stored row exists', async () => {
    const { engine, calls } = engineWith({ stored: null, computed: STORED })
    const reader = createBaselineReader({ analytics: engine as never })

    const b = await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(b).toMatchObject({ p10: 93, computedOnRead: true })
    expect(calls).toHaveLength(2)
    expect(calls[1].sql).toContain('quantile_cont')
  })

  it('uses the SAME SQL as the scheduled job — not a reimplementation', async () => {
    // This is the consistency guarantee. The reader imports
    // buildBaselineSql rather than writing its own query, so the two
    // paths cannot drift into disagreeing about what a baseline means.
    const { engine, calls } = engineWith({ stored: null, computed: STORED })
    const reader = createBaselineReader({ analytics: engine as never })
    await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(calls[1].sql).toBe(buildBaselineSql('spo2', 30))
  })

  it('is day-first, never raw-quantile', async () => {
    const { engine, calls } = engineWith({ stored: null, computed: STORED })
    const reader = createBaselineReader({ analytics: engine as never })
    await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(calls[1].sql).toContain('WITH daily_values AS')
    expect(calls[1].sql).toContain('quantile_cont(daily_value, 0.10)')
    expect(calls[1].sql).not.toContain('quantile_cont(spo2')
  })

  it('passes the configured timezone to the fallback', async () => {
    const { engine, calls } = engineWith({ stored: null, computed: STORED })
    const reader = createBaselineReader({
      analytics: engine as never,
      timezone: 'Pacific/Auckland',
    })
    await reader.getBaseline('alice', 'spo2', 30, CTX)
    expect(calls[1].params.tz).toBe('Pacific/Auckland')
  })

  it('returns null when neither path has enough days', async () => {
    const { engine } = engineWith({ stored: null, computed: null })
    const reader = createBaselineReader({ analytics: engine as never })
    expect(await reader.getBaseline('alice', 'spo2', 30, CTX)).toBeNull()
  })
})

describe('caching', () => {
  it('caches within a batch', async () => {
    const { engine, calls } = engineWith({ stored: STORED })
    const reader = createBaselineReader({ analytics: engine as never })

    await reader.getBaseline('alice', 'spo2', 30, CTX)
    await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(calls).toHaveLength(1)
  })

  it('caches the null result too — a new user shouldn\'t re-query per rule', async () => {
    const { engine, calls } = engineWith({ stored: null, computed: null })
    const reader = createBaselineReader({ analytics: engine as never })

    await reader.getBaseline('alice', 'spo2', 30, CTX)
    await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(calls).toHaveLength(2) // one stored + one compute, not four
  })

  it('keys per user, metric, and window', async () => {
    const { engine, calls } = engineWith({ stored: STORED })
    const reader = createBaselineReader({ analytics: engine as never })

    await reader.getBaseline('alice', 'spo2', 30, CTX)
    await reader.getBaseline('bob', 'spo2', 30, CTX)
    await reader.getBaseline('alice', 'hrv_ms', 30, CTX)
    await reader.getBaseline('alice', 'spo2', 7, CTX)

    expect(calls).toHaveLength(4)
  })

  it('resetCache picks up a fresh compute next batch', async () => {
    const { engine, calls } = engineWith({ stored: STORED })
    const reader = createBaselineReader({ analytics: engine as never })

    await reader.getBaseline('alice', 'spo2', 30, CTX)
    reader.resetCache()
    await reader.getBaseline('alice', 'spo2', 30, CTX)

    expect(calls).toHaveLength(2)
  })
})

describe('failure handling', () => {
  it('returns null and logs rather than failing the evaluation pass', async () => {
    const warn = vi.fn()
    const { engine } = engineWith({ throwOn: 'stored' })
    const reader = createBaselineReader({
      analytics: engine as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() } as never,
    })

    // A missing baseline is normal (new user); a failed read is not, but
    // the rule simply doesn't fire this cycle rather than taking the pass down.
    expect(await reader.getBaseline('alice', 'spo2', 30, CTX)).toBeNull()
    expect(warn).toHaveBeenCalled()
  })
})

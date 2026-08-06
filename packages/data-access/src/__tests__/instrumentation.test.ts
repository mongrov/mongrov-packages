/**
 * Sprint 5 T-45 / item (b) — query latency instrumentation.
 *
 * This exists to decide one thing with data: whether the analytics
 * watermark cache is worth enabling (gate: p95 > 20ms). So the tests that
 * matter are the ones about *not lying* — off by default, bounded memory,
 * failures excluded from the distribution.
 */

import { describe, expect, it, vi } from 'vitest'

import {
  createQueryInstrumentation,
  formatReport,
  WATERMARK_CACHE_GATE_MS,
} from '../instrumentation'

/** Advanceable clock so nothing here needs real time. */
function clock(start = 1_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => { t += ms } }
}

describe('disabled by default', () => {
  it('records nothing', () => {
    const inst = createQueryInstrumentation()
    inst.record('spo2.day', 42, true)
    expect(inst.enabled).toBe(false)
    expect(inst.statsFor('spo2.day')).toBeNull()
    expect(inst.report().queries).toEqual([])
  })

  it('measure() still runs the thunk and returns its value', async () => {
    // Disabled must be a pass-through, not a no-op that swallows work.
    const inst = createQueryInstrumentation()
    const run = vi.fn(async () => 'result')
    expect(await inst.measure('spo2.day', run)).toBe('result')
    expect(run).toHaveBeenCalledOnce()
  })
})

describe('percentiles', () => {
  it('computes p50/p95/p99 over recorded durations', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    for (const ms of [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]) {
      inst.record('spo2.day', ms, true)
    }
    const s = inst.statsFor('spo2.day')!
    expect(s.count).toBe(10)
    expect(s.p50).toBe(5)
    expect(s.p99).toBe(100)
    expect(s.min).toBe(1)
    expect(s.max).toBe(100)
  })

  it('flags a query over the watermark-cache gate', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    for (let i = 0; i < 20; i++) inst.record('slow.query', 50, true)
    for (let i = 0; i < 20; i++) inst.record('fast.query', 2, true)

    expect(inst.statsFor('slow.query')!.exceedsGate).toBe(true)
    expect(inst.statsFor('fast.query')!.exceedsGate).toBe(false)
    expect(inst.report().overGate).toEqual(['slow.query'])
  })

  it('treats the gate as strictly greater-than', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    inst.record('exactly.at.gate', WATERMARK_CACHE_GATE_MS, true)
    expect(inst.statsFor('exactly.at.gate')!.exceedsGate).toBe(false)
  })

  it('keys per query name', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    inst.record('a', 5, true)
    inst.record('b', 500, true)
    expect(inst.statsFor('a')!.p50).toBe(5)
    expect(inst.statsFor('b')!.p50).toBe(500)
  })
})

describe('rolling window', () => {
  it('drops samples older than the window', () => {
    // A slow cold start must not poison p95 for the rest of the pilot.
    const c = clock()
    const inst = createQueryInstrumentation({
      enabled: true, windowMs: 60_000, now: c.now,
    })

    inst.record('spo2.day', 900, true)   // cold start
    c.advance(61_000)
    for (let i = 0; i < 5; i++) inst.record('spo2.day', 3, true)

    const s = inst.statsFor('spo2.day')!
    expect(s.count).toBe(5)
    expect(s.max).toBe(3)
  })

  it('reports null once every sample ages out', () => {
    const c = clock()
    const inst = createQueryInstrumentation({
      enabled: true, windowMs: 1_000, now: c.now,
    })
    inst.record('spo2.day', 5, true)
    c.advance(2_000)
    expect(inst.statsFor('spo2.day')).toBeNull()
  })
})

describe('bounded memory', () => {
  it('caps samples per query, evicting oldest', () => {
    // An unbounded array on a long-lived mobile process is a leak.
    const inst = createQueryInstrumentation({ enabled: true, maxSamples: 100 })
    for (let i = 0; i < 500; i++) inst.record('spo2.day', i, true)

    const s = inst.statsFor('spo2.day')!
    expect(s.count).toBe(100)
    // The retained window is the most recent 100 (durations 400..499).
    expect(s.min).toBe(400)
    expect(s.max).toBe(499)
  })
})

describe('failures', () => {
  it('counts errors but keeps them out of the distribution', () => {
    // A query that throws after 3s consumed 3s, but folding it into the
    // read-latency distribution would make a timeout look like a slow read.
    const inst = createQueryInstrumentation({ enabled: true })
    inst.record('spo2.day', 5, true)
    inst.record('spo2.day', 3_000, false)

    const s = inst.statsFor('spo2.day')!
    expect(s.count).toBe(1)
    expect(s.errorCount).toBe(1)
    expect(s.max).toBe(5)
    expect(s.exceedsGate).toBe(false)
  })

  it('measure() records the failure and rethrows', async () => {
    const inst = createQueryInstrumentation({ enabled: true })
    const boom = new Error('engine exploded')

    await expect(
      inst.measure('spo2.day', async () => { throw boom }),
    ).rejects.toBe(boom)

    inst.record('spo2.day', 1, true) // so stats exist
    expect(inst.statsFor('spo2.day')!.errorCount).toBe(1)
  })

  it('measure() times the successful path', async () => {
    const c = clock()
    const inst = createQueryInstrumentation({ enabled: true, now: c.now })
    await inst.measure('spo2.day', async () => { c.advance(17); return 1 })
    expect(inst.statsFor('spo2.day')!.p50).toBe(17)
  })
})

describe('report', () => {
  it('orders worst p95 first', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    inst.record('fast', 1, true)
    inst.record('slowest', 300, true)
    inst.record('middling', 30, true)

    expect(inst.report().queries.map(q => q.queryName))
      .toEqual(['slowest', 'middling', 'fast'])
  })

  it('reset clears everything', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    inst.record('spo2.day', 5, true)
    inst.reset()
    expect(inst.report().queries).toEqual([])
  })
})

describe('formatReport', () => {
  it('renders a readable table with a verdict', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    for (let i = 0; i < 20; i++) inst.record('spo2.day', 45, true)
    for (let i = 0; i < 20; i++) inst.record('user.spo2SafeLevel', 1, true)

    const text = formatReport(inst.report())
    expect(text).toContain('spo2.day')
    expect(text).toContain('p95')
    expect(text).toContain('OVER')
    expect(text).toContain('Watermark caching is worth enabling')
  })

  it('says so plainly when nothing crosses the gate', () => {
    const inst = createQueryInstrumentation({ enabled: true })
    inst.record('spo2.day', 2, true)
    expect(formatReport(inst.report())).toContain('leave watermark caching off')
  })

  it('handles an empty report', () => {
    expect(formatReport(createQueryInstrumentation().report()))
      .toBe('No query samples recorded.')
  })
})

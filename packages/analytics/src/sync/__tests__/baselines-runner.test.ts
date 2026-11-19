/** The engine's baseline runner over pack-supplied definitions (S-02). */
import type { AnalyticsEngine } from '../../core/types'
import { describe, expect, it } from 'vitest'
import { createBaselineRunner } from '../baselines'

function engine(rows: Record<string, Record<string, unknown>[]>) {
  const writes: Record<string, unknown>[] = []
  const analytics = {
    boundedReads: false,
    execute: async (sql: string, params: Record<string, unknown>) => {
      if (sql.startsWith('INSERT INTO user_baseline')) {
        writes.push(params)
        return []
      }
      return rows[sql] ?? []
    },
  } as unknown as AnalyticsEngine
  return { analytics, writes }
}

const ctx = { brand: 'b', familyId: 'f', userId: 'u', userTimezone: 'UTC' }
const q = { p05: 1, p10: 2, p50: 3, p90: 4, p95: 5, mean: 3, stddev: 1 }

describe('createBaselineRunner', () => {
  it('writes a `one` row only at minDays, every `many` row, and counts the rest as skipped', async () => {
    const { analytics, writes } = engine({
      A: [{ ...q, sample_count: 25 }],
      B: [{ ...q, sample_count: 3 }],
      M: [{ ...q, metric: 'm_lo', sample_count: 30 }],
    })
    const events: unknown[] = []
    const runner = createBaselineRunner({
      analytics,
      eventBus: { emit: (_n: string, p: unknown) => events.push(p) } as never,
      providers: [{
        windows: [7],
        definitions: () => [
          { key: 'a', rows: 'one', minDays: 20, sql: (_w, bounded) => (bounded ? undefined : 'A') },
          { key: 'b', rows: 'one', minDays: 20, sql: () => 'B' },
          { key: 'm', rows: 'many', expected: 2, sql: () => 'M' },
        ],
      }],
    })
    expect(await runner.computeAll(ctx)).toEqual({ computed: 2, skipped: 2, failed: 0 })
    expect(writes.map(w => w.metric)).toEqual(['a', 'm_lo'])
    expect(events).toHaveLength(1)
  })
})

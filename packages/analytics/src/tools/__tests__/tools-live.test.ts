/**
 * AI tool SQL against real DuckDB — the user's own days (zivaone_app#24).
 *
 * Every other tool test uses a fake engine that returns canned rows, so no
 * tool's SQL had ever executed. Running it showed two things the canned rows
 * hid:
 *
 *   - days were UTC days. `date_trunc('day', ts)` on a naive-UTC column, so an
 *     Asia/Kolkata user's "day" ran 05:30 to 05:30 and the model's Tuesday
 *     disagreed with the screen's Tuesday;
 *   - the label was "2026-07-08 00:00:00", not "2026-07-08" — the fakes fed
 *     date strings the real query never produced.
 *
 * The seed: two readings 60 minutes apart that share a UTC date but straddle
 * local midnight in Asia/Kolkata (+05:30, no DST). Under the user's zone they
 * are two days; under UTC, one. Each day-bucketing tool is run both ways.
 */

import type { AnalyticsEngine } from '../../core/types'
import type { ToolContext } from '../types'
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createAnalytics } from '../../core/factory'
import { getActivityTotal } from '../impls/activity'
import { detectAnomaly } from '../impls/anomaly'
import { compareTrend } from '../impls/compare'
import { getHeartRate } from '../impls/heart-rate'
import { getHRV } from '../impls/hrv'
import { getStress } from '../impls/stress'
import { getTemperature } from '../impls/temperature'

const BRAND = 'ziva'
const USER = 'u1'
const TZ = 'Asia/Kolkata'

async function boot(): Promise<AnalyticsEngine> {
  const analytics = createAnalytics(
    { mode: 'local', storage: createFakeKV().kv, retention: {} },
    { duckdbFactory: () => createRealDuckDB(['icu']) },
  )
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (analytics.state === 'ready') { clearInterval(t); resolve() }
      if (analytics.lastError) { clearInterval(t); reject(analytics.lastError) }
    }, 10)
  })
  await analytics.attach({ brand: BRAND, tenantScope: 'family', tenantId: USER, userId: USER })
  return analytics
}

/** Kolkata's calendar date `daysBack` days ago, as YYYY-MM-DD. */
function kolkataDate(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}

/**
 * 23:30 IST on the day two days back, and 00:30 IST on the next — both on the
 * same UTC date (18:00Z and 19:00Z). Stored naive-UTC.
 */
function straddle(): { late: string, early: string, lateDay: string, earlyDay: string, utcDay: string } {
  const lateDay = kolkataDate(2)
  const earlyDay = kolkataDate(1)
  return {
    late: `${lateDay} 18:00:00`,
    early: `${lateDay} 19:00:00`,
    lateDay,
    earlyDay,
    utcDay: lateDay,
  }
}

function ctx(analytics: AnalyticsEngine, timezone?: string): ToolContext & { analytics: AnalyticsEngine } {
  return { requesterUserId: USER, brand: BRAND, familyId: USER, analytics, ...(timezone ? { timezone } : {}) }
}

async function insert(a: AnalyticsEngine, table: string, column: string, ts: string, value: number) {
  await a.execute(
    `INSERT INTO ${table} (ts, brand, family_id, user_id, device_id, ${column}) VALUES (CAST($ts AS TIMESTAMP), $b, $f, $u, 'd1', $v)`,
    { ts, b: BRAND, f: USER, u: USER, v: value },
  )
}

type Case = {
  name: string
  table: string
  column: string
  late: number
  early: number
  run: (c: ToolContext & { analytics: AnalyticsEngine }) => Promise<{ text: string }>
}

const CASES: Case[] = [
  { name: 'getHRV', table: 'hrv', column: 'hrv_ms', late: 40, early: 60, run: c => getHRV({ userId: USER, days: 7 }, c) },
  { name: 'getTemperature', table: 'temperature', column: 'temp_c', late: 36, early: 37, run: c => getTemperature({ userId: USER, days: 7 }, c) },
  { name: 'getHeartRate', table: 'heart_rate', column: 'bpm', late: 60, early: 80, run: c => getHeartRate({ userId: USER, days: 7 }, c) },
  { name: 'getStress', table: 'hrv', column: 'stress', late: 20, early: 70, run: c => getStress({ userId: USER, days: 7 }, c) },
  { name: 'getActivityTotal', table: 'activity', column: 'steps', late: 100, early: 900, run: c => getActivityTotal({ userId: USER, days: 7 }, c) },
]

describe('AI tools bucket by the user\'s own days (zivaone_app#24)', () => {
  describe.each(CASES)('$name', ({ table, column, late, early, run }) => {
    it('splits readings either side of LOCAL midnight into two days, labelled as dates', async () => {
      const a = await boot()
      try {
        const s = straddle()
        await insert(a, table, column, s.late, late)
        await insert(a, table, column, s.early, early)

        const { text } = await run(ctx(a, TZ))
        expect(text).toContain(s.lateDay)
        expect(text).toContain(s.earlyDay)
        expect(text).not.toContain('00:00:00')
      }
      finally {
        await a.close()
      }
    }, 60_000)

    it('keeps them on one day when the user\'s zone is UTC', async () => {
      const a = await boot()
      try {
        const s = straddle()
        await insert(a, table, column, s.late, late)
        await insert(a, table, column, s.early, early)

        const { text } = await run(ctx(a))
        expect(text).toContain(s.utcDay)
        expect(text).not.toContain(s.earlyDay)
      }
      finally {
        await a.close()
      }
    }, 60_000)
  })
})

describe('detectAnomaly and compareTrend execute with the zone bound', () => {
  // Their output lists only anomalous days / a single average, so the day
  // split cannot be read off the text — but the SQL must bind `$tz` only
  // where it declares it (the sleep specs do not) and run for real.
  it.each(['hrv_ms', 'activity_steps', 'sleep_total_minutes'] as const)('detectAnomaly %s', async (metric) => {
    const a = await boot()
    try {
      for (let d = 1; d <= 8; d += 1)
        await insert(a, metric === 'activity_steps' ? 'activity' : 'hrv', metric === 'activity_steps' ? 'steps' : 'hrv_ms', `${kolkataDate(d)} 06:00:00`, d === 1 ? 5 : 50)
      const res = await detectAnomaly({ userId: USER, metric, lookbackDays: 7, stddevThreshold: 1 }, ctx(a, TZ))
      expect(res.text).not.toContain('00:00:00')
    }
    finally {
      await a.close()
    }
  }, 60_000)

  it.each(['hrv_ms', 'activity_steps', 'sleep_total_minutes'] as const)('compareTrend %s', async (metric) => {
    const a = await boot()
    try {
      const res = await compareTrend({ userId: USER, metric, currentWindowDays: 7, priorWindowDays: 7 }, ctx(a, TZ))
      expect(typeof res.text).toBe('string')
    }
    finally {
      await a.close()
    }
  }, 60_000)
})

describe('getHeartRate / getStress compare to the user\'s own band', () => {
  it.each([
    ['getHeartRate', 'heart_rate', 'bpm', 'hr_bpm', 64, getHeartRate, 'usual daily average: 60–70 bpm (typical 64)'],
    ['getStress', 'hrv', 'stress', 'stress', 30, getStress, 'usual daily average: 60–70 (typical 64)'],
  ] as const)('%s reports the usual range once a baseline exists', async (_n, table, column, metric, value, tool, expected) => {
    const a = await boot()
    try {
      const s = straddle()
      await insert(a, table, column, s.early, value)
      await a.execute(
        `INSERT INTO user_baseline (brand, family_id, user_id, metric, window_days, p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
         VALUES ($b, $f, $u, $m, 30, 55, 60, 64, 70, 75, 64, 3, 25, now())`,
        { b: BRAND, f: USER, u: USER, m: metric },
      )
      const { text } = await tool({ userId: USER, days: 7 }, ctx(a, TZ))
      expect(text).toContain(expected)
    }
    finally {
      await a.close()
    }
  }, 60_000)
})

/**
 * Every shipped Ziva rule, end to end against a live local engine
 * (zivaone_app#55).
 *
 * `defaults.test.ts` proves the catalog PARSES and has the right shape. The
 * other live suites each prove one mechanism (day cadence, min-days, resting
 * context, baseline offset) on a rule written for the test. Nothing ran the
 * rules the app actually registers, through the production factories, with a
 * breach seeded — so a shipped rule whose SQL binds but whose preconditions
 * can never all hold (a floor the data cannot clear, a gate that drops every
 * sample) would pass every suite and never fire for a user.
 *
 * For each of the eleven rules:
 *
 *   - BREACH: seed data that should trip it. It must fire, write exactly one
 *     `insight` row for itself, and emit `insight:insert` on the app bus.
 *   - THROTTLE: evaluate again at once. It must not fire a second time, and
 *     must not write a second row.
 *   - CONTROL: the same shape of data on the healthy side of the threshold
 *     must not fire — otherwise the breach case would pass for a rule that
 *     fires on anything.
 *
 * Each case boots its own engine, so no rule's data can trip another.
 */

import type { AnalyticsEngine, EventBus } from '../../core/types'
import type { RulesEngine } from '../index'
import { describe, expect, it, vi } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createFakeKV } from '../../core/__tests__/__fakes__/fake-kv'
import { createAnalytics } from '../../core/factory'
import { zivaDefaults } from '../defaults'
import { createRulesEngine } from '../index'

const BRAND = 'ziva'
const USER = 'user_1'
const DEVICE = 'ring_1'

type Live = { analytics: AnalyticsEngine, rules: RulesEngine, bus: { emit: ReturnType<typeof vi.fn> } }

async function boot(): Promise<Live> {
  const { kv } = createFakeKV()
  const analytics = createAnalytics(
    { mode: 'local', storage: kv, retention: {} },
    // ICU: the day-cadence rules bucket by the user's zone.
    { duckdbFactory: () => createRealDuckDB(['icu']) },
  )
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (analytics.state === 'ready') { clearInterval(t); resolve() }
      if (analytics.lastError) { clearInterval(t); reject(analytics.lastError) }
    }, 10)
  })
  await analytics.attach({ brand: BRAND, tenantScope: 'family', tenantId: USER, userId: USER })

  const bus = { emit: vi.fn(), subscribe: vi.fn(() => () => {}), subscribePattern: vi.fn(() => () => {}) }
  const rules = createRulesEngine({
    analytics,
    storage: kv,
    familyMembersProvider: async () => [USER],
    brand: BRAND,
    familyId: USER,
    eventBus: bus as unknown as EventBus,
    // Without a zone the four day-cadence rules are skipped, not evaluated.
    userTimezoneProvider: async () => 'UTC',
  })
  await rules.register([...zivaDefaults])
  return { analytics, rules, bus }
}

/** `NOW()` minus whole minutes, as a naive-UTC TIMESTAMP. */
const AGO = `CAST(NOW() AS TIMESTAMP) - (INTERVAL 1 MINUTE) * CAST($mins AS BIGINT)`
/** Midnight of `days` UTC days ago, plus `hours`. */
const DAY_AT = `date_trunc('day', CAST(NOW() AS TIMESTAMP)) - (INTERVAL 1 DAY) * CAST($days AS BIGINT) + (INTERVAL 1 HOUR) * CAST($hours AS BIGINT)`

const ids = { brand: BRAND, fam: USER, u: USER, d: DEVICE }
const ID_COLS = 'brand, family_id, user_id, device_id'
const ID_VALS = '$brand, $fam, $u, $d'

async function atMinutesAgo(a: AnalyticsEngine, table: string, column: string, mins: number, value: number) {
  await a.execute(
    `INSERT INTO ${table} (ts, ${ID_COLS}, ${column}) VALUES (${AGO}, ${ID_VALS}, $v)`,
    { ...ids, mins, v: value },
  )
}

async function atDayHour(a: AnalyticsEngine, table: string, column: string, days: number, hours: number, value: number) {
  await a.execute(
    `INSERT INTO ${table} (ts, ${ID_COLS}, ${column}) VALUES (${DAY_AT}, ${ID_VALS}, $v)`,
    { ...ids, days, hours, v: value },
  )
}

/** Hourly readings for whole completed UTC days — clears every per-day floor. */
async function fullDays(a: AnalyticsEngine, table: string, column: string, days: number[], value: (d: number) => number) {
  for (const d of days) {
    for (let h = 0; h < 24; h += 1)
      await atDayHour(a, table, column, d, h, value(d))
  }
}

/** A reading every `step` minutes over the last `spanMins`. */
async function recent(a: AnalyticsEngine, table: string, column: string, spanMins: number, step: number, value: (mins: number) => number) {
  for (let m = 5; m <= spanMins; m += step)
    await atMinutesAgo(a, table, column, m, value(m))
}

async function baseline(a: AnalyticsEngine, metric: string, windowDays: number, p50: number) {
  await a.execute(
    `INSERT INTO user_baseline (brand, family_id, user_id, metric, window_days, p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
     VALUES ($brand, $fam, $u, $metric, $w, $v, $v, $v, $v, $v, $v, 1, 30, NOW())`,
    { brand: BRAND, fam: USER, u: USER, metric, w: windowDays, v: p50 },
  )
}

async function sleepSession(a: AnalyticsEngine, id: string, startMinsAgo: number, endMinsAgo: number, totalMinutes: number) {
  await a.execute(
    `INSERT INTO sleep_session (session_id, ts_start, ts_end, ${ID_COLS}, total_minutes, night_of)
     VALUES ($id, CAST(NOW() AS TIMESTAMP) - (INTERVAL 1 MINUTE) * CAST($s AS BIGINT),
                  CAST(NOW() AS TIMESTAMP) - (INTERVAL 1 MINUTE) * CAST($e AS BIGINT), ${ID_VALS}, $t,
             CAST(CAST(NOW() AS TIMESTAMP) - (INTERVAL 1 MINUTE) * CAST($s AS BIGINT) AS DATE))`,
    { ...ids, id, s: startMinsAgo, e: endMinsAgo, t: totalMinutes },
  )
}

type Case = {
  id: string
  /** Seed data; `breach` false seeds the healthy side of the same shape. */
  seed: (a: AnalyticsEngine, breach: boolean) => Promise<void>
}

const DAY = 1440

const CASES: Case[] = [
  {
    // 24h average below 70% of the 7-day mean (which includes the 24h).
    id: 'ziva.hrv-drop-30',
    seed: async (a, breach) => {
      await fullDays(a, 'hrv', 'hrv_ms', [2, 3, 4, 5, 6], () => 60)
      await recent(a, 'hrv', 'hrv_ms', 23 * 60, 60, () => (breach ? 25 : 58))
    },
  },
  {
    // Average nightly sleep over 3 days below 300 minutes.
    id: 'ziva.sleep-deprivation-3',
    seed: async (a, breach) => {
      for (const n of [0, 1, 2])
        await sleepSession(a, `n${n}`, n * DAY + 600, n * DAY + 360, breach ? 200 : 420)
    },
  },
  {
    // Under 20,000 steps across 7 days, with at least 6 days observed.
    id: 'ziva.low-activity-week',
    seed: async (a, breach) => {
      for (const d of [0, 1, 2, 3, 4, 5, 6]) {
        for (const h of [9, 12, 15, 18])
          await atDayHour(a, 'activity', 'steps', d, h, breach ? 100 : 2000)
      }
    },
  },
  {
    // One reading below the safe level (default 90).
    id: 'ziva.spo2-safe-level',
    seed: async (a, breach) => {
      await recent(a, 'spo2', 'spo2', 6 * 60, 30, m => (breach && m === 125 ? 85 : 97))
    },
  },
  {
    // Three consecutive asleep samples below 88. "Consecutive" is adjacent
    // 30-minute cadence slots (spo2's sampling_minutes), so the readings sit
    // 30 minutes apart.
    id: 'ziva.spo2-desaturation-asleep',
    seed: async (a, breach) => {
      await sleepSession(a, 's', 8 * 60, 60, 420)
      await recent(a, 'spo2', 'spo2', 7 * 60, 30, m => (breach && m >= 185 && m <= 245 ? 84 : 96))
    },
  },
  {
    // Max at or above 37.5 °C on two consecutive completed days.
    id: 'ziva.temp-flag-level',
    seed: async (a, breach) => {
      await fullDays(a, 'temperature', 'temp_c', [1, 2], () => (breach ? 38.1 : 36.8))
    },
  },
  {
    // Daily average 0.3 °C above the 30-day usual, two days running.
    id: 'ziva.temp-warm-days',
    seed: async (a, breach) => {
      await baseline(a, 'temp_c', 30, 36.5)
      await fullDays(a, 'temperature', 'temp_c', [1, 2], () => (breach ? 37.1 : 36.6))
    },
  },
  {
    // Daily average HRV 10 ms below usual, three days running.
    id: 'ziva.hrv-below-usual',
    seed: async (a, breach) => {
      await baseline(a, 'hrv_ms', 30, 60)
      await fullDays(a, 'hrv', 'hrv_ms', [1, 2, 3], () => (breach ? 35 : 58))
    },
  },
  {
    // Three consecutive readings at or above the flag level (default 66).
    id: 'ziva.stress-flag-level',
    seed: async (a, breach) => {
      await recent(a, 'hrv', 'stress', 4 * 60, 60, () => (breach ? 80 : 40))
    },
  },
  {
    // Daily average stress 10 above usual, two days running.
    id: 'ziva.stress-tense-days',
    seed: async (a, breach) => {
      await baseline(a, 'stress', 30, 30)
      await fullDays(a, 'hrv', 'stress', [1, 2], () => (breach ? 55 : 33))
    },
  },
  {
    // Three consecutive RESTING readings at or above the flag level (default 100).
    id: 'ziva.hr-flag-level',
    seed: async (a, breach) => {
      await recent(a, 'heart_rate', 'bpm', 3 * 60, 10, () => (breach ? 112 : 72))
    },
  },
]

/**
 * Day-cadence rules: a run that ENDED a week ago, followed by healthy days.
 *
 * Every day-cadence rule fired on this before the fix — any qualifying run
 * anywhere in its 30-day window counted — so with a one-a-day throttle a warm
 * spell that was over re-notified daily for weeks.
 */
const ENDED_RUNS: { id: string, seed: (a: AnalyticsEngine) => Promise<void> }[] = [
  {
    id: 'ziva.temp-flag-level',
    seed: async (a) => {
      await fullDays(a, 'temperature', 'temp_c', [9, 10, 11], () => 38.1)
      await fullDays(a, 'temperature', 'temp_c', [1, 2, 3, 4, 5, 6, 7, 8], () => 36.8)
    },
  },
  {
    id: 'ziva.temp-warm-days',
    seed: async (a) => {
      await baseline(a, 'temp_c', 30, 36.5)
      await fullDays(a, 'temperature', 'temp_c', [9, 10, 11], () => 37.1)
      await fullDays(a, 'temperature', 'temp_c', [1, 2, 3, 4, 5, 6, 7, 8], () => 36.6)
    },
  },
  {
    id: 'ziva.hrv-below-usual',
    seed: async (a) => {
      await baseline(a, 'hrv_ms', 30, 60)
      await fullDays(a, 'hrv', 'hrv_ms', [9, 10, 11], () => 35)
      await fullDays(a, 'hrv', 'hrv_ms', [1, 2, 3, 4, 5, 6, 7, 8], () => 58)
    },
  },
  {
    id: 'ziva.stress-tense-days',
    seed: async (a) => {
      await baseline(a, 'stress', 30, 30)
      await fullDays(a, 'hrv', 'stress', [9, 10, 11], () => 55)
      await fullDays(a, 'hrv', 'stress', [1, 2, 3, 4, 5, 6, 7, 8], () => 33)
    },
  },
]

async function insightsFor(a: AnalyticsEngine, ruleId: string): Promise<number> {
  const rows = await a.execute<{ n: number | bigint }>(
    `SELECT COUNT(*) AS n FROM insight WHERE rule_id = $r`,
    { r: ruleId },
  )
  return Number(rows[0]?.n ?? 0)
}

describe('shipped ziva rules against a live engine (zivaone_app#55)', () => {
  it('covers every shipped rule', () => {
    expect(CASES.map(c => c.id).sort()).toEqual(zivaDefaults.map(r => r.id).sort())
  })

  it('covers every shipped day-cadence rule with an ended run', () => {
    expect(ENDED_RUNS.map(c => c.id).sort())
      .toEqual(zivaDefaults.filter(r => r.cadence === 'day').map(r => r.id).sort())
  })

  it.each(ENDED_RUNS)('$id does not fire on a run that ended a week ago', async ({ id, seed }) => {
    const { analytics, rules } = await boot()
    try {
      await seed(analytics)
      const violations = await rules.evaluateScheduled()
      expect(violations.map(v => v.ruleId)).not.toContain(id)
    }
    finally {
      await analytics.close()
    }
  }, 60_000)

  describe.each(CASES)('$id', ({ id, seed }) => {
    it('fires on a breach, writes one insight, emits insight:insert, and is throttled on re-evaluation', async () => {
      const { analytics, rules, bus } = await boot()
      try {
        await seed(analytics, true)

        const first = await rules.evaluateScheduled()
        expect(first.map(v => v.ruleId)).toContain(id)
        expect(await insightsFor(analytics, id)).toBe(1)
        expect(bus.emit).toHaveBeenCalledWith('insight:insert', expect.anything())

        const second = await rules.evaluateScheduled()
        expect(second.map(v => v.ruleId)).not.toContain(id)
        expect(await insightsFor(analytics, id)).toBe(1)
      }
      finally {
        await analytics.close()
      }
    }, 60_000)

    it('stays quiet on the healthy side of the same data', async () => {
      const { analytics, rules } = await boot()
      try {
        await seed(analytics, false)
        const violations = await rules.evaluateScheduled()
        expect(violations.map(v => v.ruleId)).not.toContain(id)
        expect(await insightsFor(analytics, id)).toBe(0)
      }
      finally {
        await analytics.close()
      }
    }, 60_000)
  })
})

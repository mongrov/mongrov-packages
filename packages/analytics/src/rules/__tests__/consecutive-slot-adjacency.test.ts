/**
 * Reading-cadence `consecutive` counts SLOT-ADJACENT readings.
 *
 * Not "N most recent readings in order" — that closes gaps. Measured before
 * the fix: breaching readings at 01:00, 02:00 and 05:00 fired a
 * `consecutive: 3` rule exactly as three adjacent readings did, and SpO2's
 * Rule B had been running on that since Sprint 5.
 *
 * Consecutive is stated in cadence, not clock time: adjacent on the metric's
 * slot grid with no missing slot between. The slot index comes from the
 * reading's own timestamp, so batch arrival cannot affect it.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { compileRule } from '../compiler'
import { RuleSchema } from '../schema'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const TZ = 'America/Los_Angeles'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

function dayRule(overrides: Record<string, unknown> = {}) {
  return RuleSchema.parse({
    id: 'test.hrv-below-usual',
    name: 'HRV below usual',
    metric: 'hrv_ms',
    window: '30d',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'info',
    cadence: 'day',
    consecutive: 3,
    target: { type: 'baseline_offset', windowDays: 30, offset: 10, direction: 'below' },
    ...overrides,
  })
}

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['hrv', 'user_baseline'] as const)
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
  await db.execute(generateViewDdl('hrv', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))
  await db.execute(
    `INSERT INTO memory.user_baseline
       (brand, family_id, user_id, metric, window_days,
        p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
     VALUES ($b, $f, $u, 'hrv_ms', 30, 50, 50, 50, 50, 50, 50, 2, 25, now())`,
    { b: BRAND, f: FAMILY, u: USER },
  )
  return db
}

/**
 * Today's date in `tz`, as YYYY-MM-DD.
 *
 * The fixture has to reason in LOCAL days because the query does. Deriving
 * offsets from `new Date().setUTCDate(...)` looks equivalent and is not: run
 * this after 5pm Pacific and "yesterday UTC" is today in Los Angeles, so a
 * reading intended for a completed day lands on the partial current one and
 * is correctly excluded — which reads as the feature being broken.
 */
function localToday(tz: string): Date {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  return new Date(`${parts}T00:00:00Z`)
}

/**
 * One reading at `value`, `daysAgo` LOCAL days back.
 *
 * Stored at 20:00 UTC, which is midday in Los Angeles on the same calendar
 * date — comfortably inside the intended local day rather than near either
 * boundary, so the test is about run-counting rather than about edge rounding.
 */
async function reading(db: DB, daysAgo: number, hourUtc: number, value: number): Promise<void> {
  const d = localToday(TZ)
  d.setUTCDate(d.getUTCDate() - daysAgo)
  await db.execute(
    `INSERT INTO memory.hrv (ts, brand, family_id, user_id, device_id, hrv_ms)
     VALUES (CAST($ts AS TIMESTAMP), $b, $f, $u, 'ring_1', $v)`,
    {
      ts: `${d.toISOString().slice(0, 10)} ${String(hourUtc).padStart(2, '0')}:00:00`,
      b: BRAND,
      f: FAMILY,
      u: USER,
      v: value,
    },
  )
}

async function run(db: DB, rule = dayRule(), tz = TZ) {
  const compiled = compileRule(rule)
  return db.execute<{ observed_value: number, threshold_value: number }>(compiled.sql, {
    userId: USER,
    brand: BRAND,
    familyId: FAMILY,
    tz,
    ...compiled.params,
    baselineOffset: 10,
  })
}

describe('reading-cadence runs are slot-adjacent', () => {
  const readingRule = () => RuleSchema.parse({
    id: 'test.flag',
    name: 'n',
    metric: 'hrv_ms',
    window: '24h',
    aggregation: 'avg',
    compare: 'less_than',
    severity: 'info',
    consecutive: 3,
    target: { type: 'absolute', value: 50 },
  })

  async function fires(hours: number[]): Promise<boolean> {
    const compiled = compileRule(readingRule())
    const all: Record<string, unknown> = {
      userId: USER,
      brand: BRAND,
      familyId: FAMILY,
      tz: TZ,
      ...compiled.params,
    }
    // Bind only referenced names; an extra one fails the bind.
    const referenced = new Set(
      Array.from(compiled.sql.matchAll(/\$([a-z]\w*)/gi), m => m[1]),
    )
    const bound: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(all)) {
      if (referenced.has(k))
        bound[k] = v
    }

    const db = await boot()
    // TODAY: a 24h window excludes yesterday, and seeding there made an
    // earlier probe return false for BOTH cases — a silent control failure
    // that would have reported the defect as absent.
    for (const h of hours) await reading(db, 0, h, 30)
    const rows = await db.execute(compiled.sql, bound)
    await db.close?.()
    return rows.length > 0
  }

  it('does NOT fire across a missing slot', async () => {
    // hrv_ms is hourly. 01:00, 02:00, 05:00 is two runs of one and one of
    // one — never three adjacent slots.
    expect(await fires([1, 2, 5])).toBe(false)
  }, 60_000)

  it('fires when the slots ARE adjacent', async () => {
    // The control. Without it, the case above passes for a rule that never
    // fires at all.
    expect(await fires([1, 2, 3])).toBe(true)
  }, 60_000)
})

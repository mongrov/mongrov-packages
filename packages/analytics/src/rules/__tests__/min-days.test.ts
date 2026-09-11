/**
 * `minDays` — a window aggregate needs enough days of wear (QA #108).
 *
 * `ziva.low-activity-week` sums a week of steps and fires below 20,000. On a
 * ring paired this morning that sum is one morning's steps, so the rule told
 * a brand-new user they had been inactive all week. The floor counts distinct
 * LOCAL days with data in the window; below it the rule stays silent.
 *
 * Executed on real DuckDB with ICU, in IST, so the local-day count is the
 * user's day and not UTC's. Each "fires / does not fire" pair has a control:
 * the same data under the same rule without the floor.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { compileRule } from '../compiler'
import { zivaDefaults } from '../defaults'
import { RuleSchema } from '../schema'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const TZ = 'Asia/Kolkata'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

const shipped = zivaDefaults.find(r => r.id === 'ziva.low-activity-week')!
const unfloored = RuleSchema.parse({ ...shipped, minDays: undefined })

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  await db.execute(LOCAL_SCHEMAS.activity.replace('CREATE TABLE activity', 'CREATE TABLE memory.activity'))
  await db.execute(generateViewDdl('activity', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))
  return db
}

/**
 * `days` distinct local days of wear, `steps` each, the most recent 12 hours
 * ago. Readings 24h apart are always on different local days, and the oldest
 * (5.5 days back for six) sits well inside the 7-day window.
 */
async function wear(db: DB, days: number, steps: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    await db.execute(
      `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)
       VALUES (now() - to_hours(CAST($h AS BIGINT)), $b, $f, $u, 'ring_1', $s)`,
      { h: 12 + d * 24, b: BRAND, f: FAMILY, u: USER, s: steps },
    )
  }
}

async function fires(db: DB, rule: typeof shipped): Promise<boolean> {
  const compiled = compileRule(rule)
  const available: Record<string, unknown> = { userId: USER, brand: BRAND, familyId: FAMILY, tz: TZ, ...compiled.params }
  const bound = Object.fromEntries(Object.entries(available).filter(([k]) => compiled.sql.includes(`$${k}`)))
  return (await db.execute(compiled.sql, bound)).length > 0
}

describe('ziva.low-activity-week ships with a days-worn floor', () => {
  it('declares minDays 6 of its 7-day window', () => {
    expect(shipped.minDays).toBe(6)
    expect(shipped.window).toBe('7d')
  })
})

describe('a newly paired ring', () => {
  it('stays quiet with one day of wear — the control fires on the same data', async () => {
    const db = await boot()
    try {
      await wear(db, 1, 500)
      expect(await fires(db, unfloored)).toBe(true)
      expect(await fires(db, shipped)).toBe(false)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('stays quiet at five days, one short of the floor', async () => {
    const db = await boot()
    try {
      await wear(db, 5, 1000)
      expect(await fires(db, shipped)).toBe(false)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('fires once six days of genuinely low activity are in', async () => {
    const db = await boot()
    try {
      await wear(db, 6, 1000) // 6,000 steps in a week
      expect(await fires(db, shipped)).toBe(true)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)
})

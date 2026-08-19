/**
 * `greater_than_or_equal` is inclusive, executed against real DuckDB.
 *
 * D-E puts the stress flag at 66, which is also the lower rail of the Tense
 * zone (`tense >= 66` in STRESS_CONFIG). The rail is inclusive, so a reading
 * of exactly 66 is painted Tense on the chart. If the rule compared with
 * `greater_than`, that same reading would not count toward the alert and the
 * screen and the rule would disagree at precisely the number the user chose
 * by dragging the control there.
 *
 * The interesting case is therefore the boundary and only the boundary: 67
 * fires under either operator and proves nothing. This asserts the pair —
 * exactly-at fires for `>=` and does NOT fire for `>` — because a test that
 * only checked the first would still pass if the operator silently fell back
 * to `>` for a different reason.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { compileRule, USER_SETTING_PARAM } from '../compiler'
import { RuleSchema } from '../schema'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const TZ = 'UTC'
const FLAG = 66

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

type Compare = 'greater_than' | 'greater_than_or_equal' | 'less_than' | 'less_than_or_equal'

function flagRule(compare: Compare) {
  return RuleSchema.parse({
    id: 'test.stress-flag',
    name: 'Stress flag',
    metric: 'stress',
    window: '24h',
    aggregation: 'avg',
    compare,
    severity: 'warn',
    target: { type: 'user_setting', key: 'user:stressFlagLevel', defaultValue: FLAG },
  })
}

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  await db.execute(LOCAL_SCHEMAS.hrv.replace('CREATE TABLE hrv', 'CREATE TABLE memory.hrv'))
  await db.execute(generateViewDdl('hrv', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))
  return db
}

/** One stress reading `hoursAgo` back — well inside the 24h window. */
async function reading(db: DB, hoursAgo: number, value: number): Promise<void> {
  await db.execute(
    `INSERT INTO memory.hrv (ts, brand, family_id, user_id, device_id, stress)
     VALUES (now() - to_hours(CAST($h AS BIGINT)), $b, $f, $u, 'ring_1', $v)`,
    { h: hoursAgo, b: BRAND, f: FAMILY, u: USER, v: value },
  )
}

async function run(db: DB, compare: Compare) {
  const compiled = compileRule(flagRule(compare))
  const available: Record<string, unknown> = {
    userId: USER,
    brand: BRAND,
    familyId: FAMILY,
    tz: TZ,
    ...compiled.params,
    [USER_SETTING_PARAM]: FLAG,
  }
  // Bind only what the SQL actually names. The adapter binds every key it is
  // handed, and DuckDB rejects a parameter the statement never mentions — a
  // 24h rule has no reason to reference $tz.
  const bound = Object.fromEntries(
    Object.entries(available).filter(([k]) => compiled.sql.includes(`$${k}`)),
  )
  return db.execute<{ observed_value: number }>(compiled.sql, bound)
}

describe('a reading exactly at the flag', () => {
  it('fires under >= and stays silent under >', async () => {
    const db = await boot()
    try {
      // Every reading is exactly the flag, so the average is exactly the flag.
      // Three of them, because one reading averaging to the boundary could be
      // an artefact of how a single row aggregates.
      for (const h of [1, 2, 3]) await reading(db, h, FLAG)

      const inclusive = await run(db, 'greater_than_or_equal')
      expect(inclusive).toHaveLength(1)
      expect(Number(inclusive[0].observed_value)).toBe(FLAG)

      // The control. If this also returned a row, the assertion above would
      // be satisfied by an operator that ignores its own inclusivity.
      const strict = await run(db, 'greater_than')
      expect(strict).toHaveLength(0)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('mirrors the behaviour downward, so the pair cannot drift apart', async () => {
    // `less_than_or_equal` has no shipped rule behind it today. It exists
    // because an enum with only one inclusive half invites the other half to
    // be added later without a test, and it is covered here for the same
    // reason: an untested operator is one someone will reach for and trust.
    const db = await boot()
    try {
      for (const h of [1, 2, 3]) await reading(db, h, FLAG)

      expect(await run(db, 'less_than_or_equal')).toHaveLength(1)
      expect(await run(db, 'less_than')).toHaveLength(0)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)
})

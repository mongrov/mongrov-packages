/**
 * The `resting` context gate, executed against real DuckDB.
 *
 * `emitContextJoin` is covered by string assertions, which cannot tell you
 * whether `ANTI JOIN` is valid DuckDB or whether the window boundaries land
 * where they should. Both matter here: this join is what stands between an
 * exercise peak and a heart-rate alert.
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { compileRule, USER_SETTING_PARAM } from '../compiler'
import { RuleSchema } from '../schema'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const FLAG = 100

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

function restingFlagRule() {
  return RuleSchema.parse({
    id: 'test.hr-flag',
    name: 'HR flag',
    metric: 'hr_bpm',
    window: '24h',
    aggregation: 'avg',
    compare: 'greater_than_or_equal',
    severity: 'warn',
    context: 'resting',
    target: { type: 'user_setting', key: 'user:hrFlagLevel', defaultValue: FLAG },
  })
}

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['heart_rate', 'activity'] as const)
    await db.execute(LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
  for (const t of ['heart_rate', 'activity'] as const)
    await db.execute(generateViewDdl(t, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }))
  return db
}

async function hr(db: DB, minutesAgo: number, bpm: number): Promise<void> {
  await db.execute(
    `INSERT INTO memory.heart_rate (ts, brand, family_id, user_id, device_id, bpm)
     VALUES (now() - to_minutes(CAST($m AS BIGINT)), $b, $f, $u, 'ring_1', $v)`,
    { m: minutesAgo, b: BRAND, f: FAMILY, u: USER, v: bpm },
  )
}

async function steps(db: DB, minutesAgo: number, count: number): Promise<void> {
  await db.execute(
    `INSERT INTO memory.activity (ts, brand, family_id, user_id, device_id, steps)
     VALUES (now() - to_minutes(CAST($m AS BIGINT)), $b, $f, $u, 'ring_1', $v)`,
    { m: minutesAgo, b: BRAND, f: FAMILY, u: USER, v: count },
  )
}

async function run(db: DB) {
  const compiled = compileRule(restingFlagRule())
  const available: Record<string, unknown> = {
    userId: USER,
    brand: BRAND,
    familyId: FAMILY,
    tz: 'UTC',
    ...compiled.params,
    [USER_SETTING_PARAM]: FLAG,
  }
  const bound = Object.fromEntries(
    Object.entries(available).filter(([k]) => compiled.sql.includes(`$${k}`)),
  )
  return db.execute<{ observed_value: number }>(compiled.sql, bound)
}

describe('a resting-gated rule', () => {
  it('fires on high readings taken while still', async () => {
    const db = await boot()
    try {
      // No activity rows at all. Under the previous zero-step INNER JOIN this
      // returned nothing — the gate dropped every sample for want of a row to
      // join to, and the rule could never fire on a device that reports
      // activity only when the user moves.
      for (const m of [10, 20, 30]) await hr(db, m, 120)
      const rows = await run(db)
      expect(rows).toHaveLength(1)
      expect(Number(rows[0].observed_value)).toBe(120)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('excludes readings taken while moving', async () => {
    const db = await boot()
    try {
      // Exercise: 160 bpm with steps in the same minute. Slot table decision
      // 2 — exercise highs are context, never exceptions.
      await hr(db, 10, 160)
      await steps(db, 10, 400)
      const rows = await run(db)
      expect(rows).toHaveLength(0)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('excludes a reading up to 15 minutes after movement, and admits one past it', async () => {
    const db = await boot()
    try {
      await steps(db, 30, 400)
      // 14 min after the steps — inside the window, so gated out.
      await hr(db, 16, 150)
      expect(await run(db)).toHaveLength(0)

      // 16 min after — outside the window, so it counts.
      await hr(db, 14, 150)
      const rows = await run(db)
      expect(rows).toHaveLength(1)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('is not fooled by a zero-step row, which is not movement', async () => {
    const db = await boot()
    try {
      await hr(db, 10, 120)
      await steps(db, 10, 0)
      // `a.steps > 0` is the gate, so a zero-step row must not exclude
      // anything — it is evidence of stillness, not of movement.
      expect(await run(db)).toHaveLength(1)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)
})

/**
 * The `resting` context gate, executed against real DuckDB.
 *
 * `emitContextJoin` is covered by string assertions, which cannot tell you
 * whether `ANTI JOIN` is valid DuckDB or whether the window boundaries land
 * where they should. Both matter here: this join is what stands between an
 * exercise peak and a heart-rate alert.
 */
import { describe, expect, it } from 'vitest'

import { createQualityViews } from '../../__integration__/setup/quality-views'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { STILL_FLOOR, STILL_WINDOW_MINUTES } from '../../core/reading-quality'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { compileRule, emitContextJoin, USER_SETTING_PARAM } from '../compiler'
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
  // T-25: rules/baselines/tools read the clean views.
  await createQualityViews(db, { brand: BRAND, familyId: FAMILY })
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

  it('treats a few steps below the movement floor as resting (mongrov-packages#6)', async () => {
    // A worn ring logs a handful of steps in most waking minutes — shifting in
    // a chair is not exercise. The chart's `still` flag and the baseline's
    // resting average both use the §7g floor (STILL_FLOOR steps in the ±15 min
    // window); under `steps > 0` this rule alone called the reading moving,
    // so an elevated resting HR next to a few fidgety steps never alerted.
    const db = await boot()
    try {
      for (const m of [10, 20, 30]) await hr(db, m, 120)
      await steps(db, 20, 12) // well under the floor of 50 in any window
      const rows = await run(db)
      expect(rows).toHaveLength(1)
    }
    finally {
      await db.close?.()
    }
  }, 120_000)

  it('classifies resting row-for-row like the windowed-sum definition (mongrov-packages#6)', async () => {
    // The bar 0.27.0's `still` cleared: agreement with the slow, obvious
    // definition on data that exercises both outcomes, including the ±15 min
    // half-open edges.
    const db = await boot()
    try {
      await db.execute(`INSERT INTO memory.heart_rate
        SELECT now() - INTERVAL 1 DAY + (INTERVAL 5 MINUTE) * g, $b, $f, $u, 'ring_1', 60 + (g % 20)
        FROM generate_series(0, 287) AS t(g)`, { b: BRAND, f: FAMILY, u: USER })
      await db.execute(`INSERT INTO memory.activity
        SELECT now() - INTERVAL 1 DAY + (INTERVAL 1 MINUTE) * g, $b, $f, $u, 'ring_1',
               CASE WHEN (g % 97) < 11 THEN 1 + (g % 9) ELSE 0 END
        FROM generate_series(0, 1439) AS t(g)`, { b: BRAND, f: FAMILY, u: USER })

      const gated = `SELECT m.ts FROM v_heart_rate_clean m${emitContextJoin('resting', 'heart_rate')}`
      const reference = `SELECT m.ts FROM v_heart_rate_clean m
        WHERE COALESCE((
          SELECT sum(a.steps) FROM v_activity a
          WHERE a.user_id = m.user_id AND a.brand = m.brand AND a.family_id = m.family_id
            AND a.ts >= m.ts - INTERVAL ${STILL_WINDOW_MINUTES} MINUTE
            AND a.ts <  m.ts + INTERVAL ${STILL_WINDOW_MINUTES} MINUTE
        ), 0) < ${STILL_FLOOR}`
      const [{ n }] = await db.execute<{ n: number }>(
        `SELECT count(*)::INTEGER AS n FROM ((${gated} EXCEPT ${reference}) UNION ALL (${reference} EXCEPT ${gated}))`,
      )
      expect(n).toBe(0)

      const [{ resting, total }] = await db.execute<{ resting: number, total: number }>(
        `SELECT (SELECT count(*) FROM (${reference}))::INTEGER AS resting,
                (SELECT count(*) FROM v_heart_rate_clean)::INTEGER AS total`,
      )
      // Both outcomes present, or agreement would be vacuous.
      expect(resting).toBeGreaterThan(0)
      expect(resting).toBeLessThan(total)
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

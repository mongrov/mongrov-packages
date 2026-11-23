/**
 * `rawSql` binds (`$tz`, `rawSqlSettings`) and `baseline_offset.percentile`.
 *
 * A pack can write a rule on the same SQL its screens use: grouped by the
 * user's local hour or local day (`$tz`), over a session table with a value
 * the pack chooses, against a per-user setting — all bound, never
 * interpolated. Executed against real DuckDB through the production evaluator,
 * because what matters is which rows the bound values select.
 */
import type { AnalyticsPack } from '../../core/packs'
import type { AnalyticsEngine } from '../../core/types'
import type { Rule } from '../schema'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { DEFAULT_PACKS } from '../../__tests__/packs'
import { setDefaultPacks } from '../../core/packs'
import { createFakeEngine } from '../__fakes__/fakeEngine'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { compileRule } from '../compiler'
import { createRulesEngine } from '../factory'
import { RuleSchema, RuleValidationError } from '../schema'
import { validateRule } from '../validator'

const BRAND = 'acme'
const FAMILY = 'fam_1'
const USER = 'alice'
const LEVEL_KEY = 'user:gaugeLevel'
const COUNT_KEY = 'user:sessionCount'

/** A neutral pack: an hourly gauge and a session table with two minute columns. */
const TABLES = {
  gauge: `CREATE TABLE gauge (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  level DOUBLE
);`,
  work_session: `CREATE TABLE work_session (
  session_id VARCHAR PRIMARY KEY,
  ts_start TIMESTAMP NOT NULL,
  ts_end TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  total_minutes INTEGER NOT NULL,
  idle_minutes INTEGER
);`,
} as const

const SETTINGS = new Set([LEVEL_KEY, COUNT_KEY])

const METER_PACK: AnalyticsPack = {
  name: 'meter',
  tables: {
    gauge: { ddl: TABLES.gauge, timeColumn: 'ts', syncable: true, retention: null },
    work_session: { ddl: TABLES.work_session, timeColumn: 'ts_end', syncable: true, retention: null },
  },
  metrics: {
    gauge_level: { table: 'gauge', column: 'level', sampling_minutes: 60, exposure: 'full' },
    session_minutes: { table: 'work_session', column: 'total_minutes', sampling_minutes: 'per_session', exposure: 'full' },
  },
  rules: {
    settings: {
      readable: k => SETTINGS.has(k),
      registered: k => SETTINGS.has(k),
      valueType: k => (SETTINGS.has(k) ? 'number' : undefined),
      readableKeys: () => [...SETTINGS],
      registryName: 'the meter settings',
    },
  },
}

beforeAll(() => setDefaultPacks([METER_PACK]))
afterAll(() => setDefaultPacks(DEFAULT_PACKS))

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

async function boot(tables: ReadonlyArray<keyof typeof TABLES | 'user_baseline'>): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const t of tables) {
    if (t === 'user_baseline') {
      await db.execute(`CREATE TABLE memory.user_baseline (
        brand VARCHAR, family_id VARCHAR, user_id VARCHAR, metric VARCHAR, window_days SMALLINT,
        p05 DOUBLE, p10 DOUBLE, p50 DOUBLE, p90 DOUBLE, p95 DOUBLE)`)
      continue
    }
    await db.execute(TABLES[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`))
    await db.execute(`CREATE OR REPLACE VIEW v_${t} AS SELECT * FROM memory.${t}`)
  }
  return db
}

/** The production evaluator over a real DuckDB; insight writes are dropped. */
function engineOver(db: DB, opts: { tz?: string, stored?: Record<string, unknown> } = {}) {
  const fake = createFakeEngine()
  const calls: { sql: string, params: Record<string, unknown> }[] = []
  const analytics: AnalyticsEngine = {
    ...fake,
    async execute<T>(sql: string, params?: Record<string, unknown>): Promise<T[]> {
      if (sql.includes('INSERT INTO insight'))
        return []
      calls.push({ sql, params: params ?? {} })
      return db.execute<T>(sql, params)
    },
  }
  const storage = createFakeStorage()
  for (const [k, v] of Object.entries(opts.stored ?? {}))
    void storage.set(`analytics:${USER}:${k}`, v)
  const rules = createRulesEngine({
    analytics,
    storage,
    brand: BRAND,
    familyId: FAMILY,
    familyMembersProvider: async () => [USER],
    userTimezoneProvider: async () => opts.tz,
  })
  return { rules, calls }
}

// ── local hour ─────────────────────────────────────────────────────────────

/**
 * Fires when any LOCAL hour of yesterday averaged above the user's level —
 * a per-hour grouping no generated rule can express.
 */
const LOCAL_HOUR_SQL = `
WITH hourly AS (
  SELECT hour(timezone(CAST($tz AS VARCHAR), timezone('UTC', m.ts))) AS local_hour,
         AVG(m.level) AS value
  FROM v_gauge m
  WHERE m.user_id = $userId AND m.brand = $brand AND m.family_id = $familyId
    AND m.ts > NOW() - INTERVAL 3 DAY
  GROUP BY local_hour
)
SELECT MAX(value) AS observed_value, CAST($level AS DOUBLE) AS threshold_value
FROM hourly
WHERE local_hour = CAST($hour AS BIGINT)
HAVING MAX(value) > CAST($level AS DOUBLE);`

function localHourRule(hour: number): Rule {
  return RuleSchema.parse({
    id: 'test.local-hour',
    name: 'Local hour above level',
    metric: 'gauge_level',
    window: '3d',
    compare: 'greater_than',
    severity: 'info',
    target: { type: 'absolute', value: 0 },
    rawSql: LOCAL_HOUR_SQL.replace('CAST($hour AS BIGINT)', String(hour)),
    rawSqlSettings: { level: { key: LEVEL_KEY, defaultValue: 60 } },
  })
}

/** One reading at a fixed UTC hour, `daysAgo` days back. */
async function seedLevelAt(db: DB, utcHour: number, value: number, daysAgo = 1): Promise<void> {
  await db.execute(
    `INSERT INTO memory.gauge (ts, brand, family_id, user_id, device_id, level)
     VALUES (date_trunc('day', now()) - (INTERVAL 1 DAY) * CAST($d AS BIGINT)
             + (INTERVAL 1 HOUR) * CAST($h AS BIGINT), $b, $f, $u, 'dev_1', $v)`,
    { d: daysAgo, h: utcHour, b: BRAND, f: FAMILY, u: USER, v: value },
  )
}

describe('rawSql reads $tz — grouping by the user\'s local hour', () => {
  it('buckets a reading into the hour of the user\'s zone, not UTC', async () => {
    const db = await boot(['gauge'])
    await seedLevelAt(db, 7, 80)
    // The local hour the stored reading falls in, for this date (EST/EDT).
    const [{ h }] = await db.execute<{ h: number }>(
      `SELECT CAST(hour(timezone('America/New_York', timezone('UTC', ts))) AS INTEGER) AS h FROM v_gauge`,
    )
    expect(Number(h)).not.toBe(7)

    const fired = engineOver(db, { tz: 'America/New_York' }).rules
    await fired.register([localHourRule(Number(h))])
    expect(await fired.evaluateScheduled()).toHaveLength(1)

    // Same SQL, same readings, UTC zone: local hour h holds nothing.
    const utc = engineOver(db, { tz: 'UTC' }).rules
    await utc.register([localHourRule(Number(h))])
    expect(await utc.evaluateScheduled()).toHaveLength(0)
    await db.close?.()
  })

  it('binds the stored setting, and falls back to its default', async () => {
    const db = await boot(['gauge'])
    await seedLevelAt(db, 12, 70)

    const { rules: dflt, calls } = engineOver(db, { tz: 'UTC' })
    await dflt.register([localHourRule(12)])
    const [v] = await dflt.evaluateScheduled()
    expect(v?.thresholdValue).toBe(60) // default 60 < 70 ⇒ fires
    expect(calls.at(-1)!.params.level).toBe(60)
    expect(calls.at(-1)!.params.tz).toBe('UTC')
    expect(v?.evidence.rawSqlSettingsUsed).toEqual({ level: { key: LEVEL_KEY, value: 60 } })

    const stored = engineOver(db, { tz: 'UTC', stored: { [LEVEL_KEY]: 75 } }).rules
    await stored.register([localHourRule(12)])
    expect(await stored.evaluateScheduled()).toHaveLength(0) // 70 is under 75
    await db.close?.()
  })

  it('skips the rule for a user with no zone rather than guessing UTC', async () => {
    const db = await boot(['gauge'])
    await seedLevelAt(db, 12, 90)
    const { rules, calls } = engineOver(db, {})
    await rules.register([localHourRule(12)])
    expect(await rules.evaluateScheduled()).toHaveLength(0)
    expect(calls.filter(c => c.sql.includes('hourly'))).toHaveLength(0)
    await db.close?.()
  })
})

// ── per session, pack-chosen value ─────────────────────────────────────────

/**
 * "The value the pack chooses (total minus idle) was under the user's floor
 * on each of the last N sessions, by the local day each ended" — a session
 * table, a computed column, a local-day key and two settings.
 */
const SESSIONS_SQL = `
WITH per_day AS (
  SELECT CAST(timezone(CAST($tz AS VARCHAR), timezone('UTC', s.ts_end)) AS DATE) AS local_day,
         SUM(s.total_minutes - COALESCE(s.idle_minutes, 0)) AS value
  FROM v_work_session s
  WHERE s.user_id = $userId AND s.brand = $brand AND s.family_id = $familyId
    AND s.ts_end > NOW() - INTERVAL 14 DAY
  GROUP BY local_day
),
last_n AS (
  SELECT value FROM per_day ORDER BY local_day DESC LIMIT CAST($count AS BIGINT)
)
SELECT MAX(value) AS observed_value, CAST($floor AS DOUBLE) AS threshold_value
FROM last_n
HAVING COUNT(*) = CAST($count AS BIGINT) AND MAX(value) < CAST($floor AS DOUBLE);`

function sessionsRule(): Rule {
  return RuleSchema.parse({
    id: 'test.under-floor-sessions',
    name: 'Under floor on N sessions',
    metric: 'session_minutes',
    window: '7d',
    compare: 'less_than',
    severity: 'info',
    target: { type: 'absolute', value: 0 },
    rawSql: SESSIONS_SQL,
    rawSqlSettings: {
      floor: { key: LEVEL_KEY, defaultValue: 300 },
      count: { key: COUNT_KEY, defaultValue: 3 },
    },
  })
}

async function seedSessions(db: DB, minutes: Array<{ total: number, idle: number }>): Promise<void> {
  for (const [i, m] of minutes.entries()) {
    await db.execute(
      `INSERT INTO memory.work_session
         (session_id, ts_start, ts_end, brand, family_id, user_id, device_id, total_minutes, idle_minutes)
       VALUES ($id, date_trunc('day', now()) - (INTERVAL 1 DAY) * CAST($d AS BIGINT) - INTERVAL 6 HOUR,
               date_trunc('day', now()) - (INTERVAL 1 DAY) * CAST($d AS BIGINT) + INTERVAL 1 HOUR,
               $b, $f, $u, 'dev_1', $t, $a)`,
      { id: `s${i}`, d: i, b: BRAND, f: FAMILY, u: USER, t: m.total, a: m.idle },
    )
  }
}

describe('rawSql over a session table, with a pack-chosen value', () => {
  // 3 × (330 total, 40 idle) = 290 counted each: under a 300 floor, over 270.
  const three = Array.from({ length: 3 }, () => ({ total: 330, idle: 40 }))

  it('fires when each of the last N sessions is under the floor', async () => {
    const db = await boot(['work_session'])
    await seedSessions(db, three)
    const { rules } = engineOver(db, { tz: 'UTC' })
    await rules.register([sessionsRule()])
    const [v] = await rules.evaluateScheduled()
    expect(v?.observedValue).toBe(290)
    expect(v?.thresholdValue).toBe(300)
    await db.close?.()
  })

  it('does not fire under a lower stored floor', async () => {
    const db = await boot(['work_session'])
    await seedSessions(db, three)
    const { rules } = engineOver(db, { tz: 'UTC', stored: { [LEVEL_KEY]: 270 } })
    await rules.register([sessionsRule()])
    expect(await rules.evaluateScheduled()).toHaveLength(0)
    await db.close?.()
  })

  it('reads N from its setting: fewer sessions than N never fire', async () => {
    const db = await boot(['work_session'])
    await seedSessions(db, three)
    const { rules } = engineOver(db, { tz: 'UTC', stored: { [COUNT_KEY]: 4 } })
    await rules.register([sessionsRule()])
    expect(await rules.evaluateScheduled()).toHaveLength(0)
    await db.close?.()
  })
})

// ── compile / validate ─────────────────────────────────────────────────────

describe('rawSql binds — compile and validation', () => {
  const base = {
    id: 'test.raw',
    name: 'Raw',
    metric: 'gauge_level',
    window: '24h',
    compare: 'greater_than',
    severity: 'info',
    target: { type: 'absolute', value: 0 },
  } as const

  it('a rawSql rule reading neither $tz nor settings compiles exactly as before', () => {
    const c = compileRule(RuleSchema.parse({ ...base, rawSql: 'SELECT 1 AS observed_value, 0 AS threshold_value WHERE $userId = $userId' }))
    expect(c).toEqual({
      ruleId: 'test.raw',
      metric: 'gauge_level',
      sql: 'SELECT 1 AS observed_value, 0 AS threshold_value WHERE $userId = $userId',
      params: {},
      description: 'rawSql:gauge_level',
    })
  })

  it('an undeclared placeholder is still rejected', () => {
    expect(() => compileRule(RuleSchema.parse({ ...base, rawSql: 'SELECT $level' })))
      .toThrow(RuleValidationError)
  })

  it('a setting may not take an engine-bound name', () => {
    expect(() => compileRule(RuleSchema.parse({
      ...base,
      rawSql: 'SELECT $tz',
      rawSqlSettings: { tz: { key: LEVEL_KEY, defaultValue: 1 } },
    }))).toThrow(/bound by the engine/)
  })

  it('a setting key must be rule-readable', () => {
    expect(() => validateRule(RuleSchema.parse({
      ...base,
      rawSql: 'SELECT $level',
      rawSqlSettings: { level: { key: 'user:notARealKey', defaultValue: 1 } },
    }))).toThrow(/not a rule-readable setting/)
  })

  it('settings without a rawSql body are rejected', () => {
    expect(() => validateRule(RuleSchema.parse({
      ...base,
      rawSqlSettings: { level: { key: LEVEL_KEY, defaultValue: 1 } },
    }))).toThrow(/needs a rawSql body/)
  })

  it('the evaluator binds settings on the fake engine too (no SQL semantics)', async () => {
    const engine = createFakeEngine()
    const rules = createRulesEngine({
      analytics: engine,
      storage: createFakeStorage(),
      brand: BRAND,
      familyId: FAMILY,
      familyMembersProvider: async () => [USER],
    })
    await rules.register([RuleSchema.parse({
      ...base,
      rawSql: 'SELECT $level AS observed_value',
      rawSqlSettings: { level: { key: LEVEL_KEY, defaultValue: 7 } },
    })])
    await rules.evaluateScheduled()
    const call = engine.__calls.find(c => c.sql.includes('$level'))!
    expect(call.params.level).toBe(7)
    expect(call.params.tz).toBeUndefined()
  })
})

// ── baseline_offset.percentile ─────────────────────────────────────────────

describe('baseline_offset against a named percentile', () => {
  const offsetRule = (percentile?: string) => RuleSchema.parse({
    id: 'test.above-usual',
    name: 'Above usual',
    metric: 'gauge_level',
    window: '24h',
    aggregation: 'avg',
    compare: 'greater_than',
    severity: 'info',
    target: {
      type: 'baseline_offset',
      windowDays: 30,
      offset: 2,
      direction: 'above',
      ...(percentile === undefined ? {} : { percentile }),
    },
  })

  async function seeded(): Promise<DB> {
    const db = await boot(['gauge', 'user_baseline'])
    await db.execute(
      `INSERT INTO memory.user_baseline
         (brand, family_id, user_id, metric, window_days, p05, p10, p50, p90, p95)
       VALUES ($b, $f, $u, 'gauge_level', 30, 30, 35, 50, 70, 75)`,
      { b: BRAND, f: FAMILY, u: USER },
    )
    await db.execute(
      `INSERT INTO memory.gauge (ts, brand, family_id, user_id, device_id, level)
       SELECT now() - INTERVAL (i) HOUR, $b, $f, $u, 'dev_1', 60 FROM range(1, 5) t(i)`,
      { b: BRAND, f: FAMILY, u: USER },
    )
    return db
  }

  const run = async (db: DB, rule: Rule) => {
    const c = compileRule(rule)
    return db.execute<{ observed_value: number, threshold_value: number }>(
      c.sql,
      { userId: USER, brand: BRAND, familyId: FAMILY, ...c.params },
    )
  }

  it('omitted percentile compiles to the identical p50 SQL', () => {
    expect(compileRule(offsetRule('p50')).sql).toBe(compileRule(offsetRule()).sql)
    expect(compileRule(offsetRule()).description).toContain('baseline p50')
  })

  it('p50 fires (60 > 50 + 2); p90 does not (60 < 70 + 2)', async () => {
    const db = await seeded()
    const p50 = await run(db, offsetRule())
    expect(p50).toHaveLength(1)
    expect(p50[0]!.threshold_value).toBe(52)
    expect(await run(db, offsetRule('p90'))).toHaveLength(0)
    await db.close?.()
  })

  it('day cadence reads the named percentile too', () => {
    const r = RuleSchema.parse({
      ...offsetRule('p90'),
      window: '30d',
      cadence: 'day',
      consecutive: 2,
    })
    const sql = compileRule(r).sql
    expect(sql).toContain('SELECT p90\n  FROM user_baseline')
    expect(sql).toContain('(SELECT p90 FROM baseline)')
  })

  it('rejects an unknown percentile at parse', () => {
    expect(() => offsetRule('p75')).toThrow()
  })
})

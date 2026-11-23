/**
 * `rawSql` binds added in 0.64: string `rawSqlSettings` and `$deviceId`.
 *
 * A named setting (a mode, a sensitivity) reaches the SQL as a bound string,
 * so the rule can map it with a CASE; a stored value is data, never SQL text.
 * `$deviceId` scopes a rule to the device the app names for the user, and is
 * NULL when it names none. Executed against real DuckDB through the
 * production evaluator, because what matters is which rows the bound values
 * select.
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
import { rawSqlSettingType, RuleSchema, RuleValidationError } from '../schema'
import { validateRule } from '../validator'

const BRAND = 'acme'
const FAMILY = 'fam_1'
const USER = 'alice'
const LEVEL_KEY = 'user:gaugeLevel' // number, rule-readable
const MODE_KEY = 'user:gaugeMode' // string, registered, not a threshold

const GAUGE_DDL = `CREATE TABLE gauge (
  ts TIMESTAMP NOT NULL,
  brand VARCHAR NOT NULL,
  family_id VARCHAR NOT NULL,
  user_id VARCHAR NOT NULL,
  device_id VARCHAR NOT NULL,
  level DOUBLE
);`

const TYPES: Record<string, string> = { [LEVEL_KEY]: 'number', [MODE_KEY]: 'string' }

const METER_PACK: AnalyticsPack = {
  name: 'meter',
  tables: {
    gauge: { ddl: GAUGE_DDL, timeColumn: 'ts', syncable: true, retention: null },
  },
  metrics: {
    gauge_level: { table: 'gauge', column: 'level', sampling_minutes: 60, exposure: 'full' },
  },
  rules: {
    settings: {
      readable: k => k === LEVEL_KEY,
      registered: k => k in TYPES,
      valueType: k => TYPES[k],
      readableKeys: () => [LEVEL_KEY],
      registryName: 'the meter settings',
    },
  },
}

beforeAll(() => setDefaultPacks([METER_PACK]))
afterAll(() => setDefaultPacks(DEFAULT_PACKS))

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  await db.execute(GAUGE_DDL.replace('CREATE TABLE gauge', 'CREATE TABLE memory.gauge'))
  await db.execute(`CREATE OR REPLACE VIEW v_gauge AS SELECT * FROM memory.gauge`)
  return db
}

/** One reading `hoursAgo` back on `device`. */
async function seed(db: DB, device: string, level: number, hoursAgo = 1): Promise<void> {
  await db.execute(
    `INSERT INTO memory.gauge (ts, brand, family_id, user_id, device_id, level)
     VALUES (now() - (INTERVAL 1 HOUR) * CAST($h AS BIGINT), $b, $f, $u, $d, $v)`,
    { h: hoursAgo, b: BRAND, f: FAMILY, u: USER, d: device, v: level },
  )
}

interface EngineOpts {
  stored?: Record<string, unknown>
  device?: () => Promise<string | undefined>
}

/** The production evaluator over a real DuckDB; insight writes are dropped. */
function engineOver(db: DB, opts: EngineOpts = {}) {
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
    userTimezoneProvider: async () => 'UTC',
    ...(opts.device ? { userDeviceProvider: opts.device } : {}),
  })
  return { rules, calls }
}

const base = {
  id: 'test.raw',
  name: 'Raw',
  metric: 'gauge_level',
  window: '24h',
  compare: 'greater_than',
  severity: 'info',
  target: { type: 'absolute', value: 0 },
} as const

// ── string settings ────────────────────────────────────────────────────────

/**
 * The last day's average above the user's level, widened or narrowed by a
 * NAMED mode the SQL maps to a factor. An unknown name falls to ELSE.
 */
const MODE_SQL = `
WITH f AS (
  SELECT CASE CAST($mode AS VARCHAR)
           WHEN 'wide' THEN 1.5 WHEN 'narrow' THEN 0.5 ELSE 1.0 END AS factor
),
recent AS (
  SELECT AVG(level) AS v FROM v_gauge
  WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
    AND ts > NOW() - INTERVAL 1 DAY
)
SELECT v AS observed_value, CAST($level AS DOUBLE) * (SELECT factor FROM f) AS threshold_value
FROM recent
WHERE v > CAST($level AS DOUBLE) * (SELECT factor FROM f);`

function modeRule(mode: Record<string, unknown> = { key: MODE_KEY, defaultValue: 'normal' }): Rule {
  return RuleSchema.parse({
    ...base,
    id: 'test.mode',
    rawSql: MODE_SQL,
    rawSqlSettings: {
      level: { key: LEVEL_KEY, defaultValue: 60 },
      mode,
    },
  })
}

describe('rawSqlSettings: a string setting binds the stored name', () => {
  it('binds the default name when unset, and the stored name when set', async () => {
    const db = await boot()
    await seed(db, 'dev_1', 70) // 70 > 60 × 1.0; 70 < 60 × 1.5; 70 > 60 × 0.5

    const dflt = engineOver(db)
    await dflt.rules.register([modeRule()])
    const [v] = await dflt.rules.evaluateScheduled()
    expect(v?.thresholdValue).toBe(60)
    expect(dflt.calls.at(-1)!.params.mode).toBe('normal')
    expect(v?.evidence.rawSqlSettingsUsed).toEqual({
      level: { key: LEVEL_KEY, value: 60 },
      mode: { key: MODE_KEY, value: 'normal' },
    })

    const wide = engineOver(db, { stored: { [MODE_KEY]: 'wide' } })
    await wide.rules.register([modeRule()])
    expect(await wide.rules.evaluateScheduled()).toHaveLength(0)
    expect(wide.calls.at(-1)!.params.mode).toBe('wide')

    const narrow = engineOver(db, { stored: { [MODE_KEY]: 'narrow' } })
    await narrow.rules.register([modeRule()])
    const [n] = await narrow.rules.evaluateScheduled()
    expect(n?.thresholdValue).toBe(30)
    await db.close?.()
  })

  it('reads a JSON-quoted stored string as the name', async () => {
    const db = await boot()
    await seed(db, 'dev_1', 70)
    const { rules, calls } = engineOver(db, { stored: { [MODE_KEY]: '"wide"' } })
    await rules.register([modeRule()])
    expect(await rules.evaluateScheduled()).toHaveLength(0)
    expect(calls.at(-1)!.params.mode).toBe('wide')
    await db.close?.()
  })

  it.each([
    ['a number', 1.5],
    ['a boolean', true],
    ['an object', { name: 'wide' }],
    ['an empty string', ''],
  ])('a stored non-string (%s) binds the default', async (_label, stored) => {
    const db = await boot()
    await seed(db, 'dev_1', 70)
    const { rules, calls } = engineOver(db, { stored: { [MODE_KEY]: stored } })
    await rules.register([modeRule({ key: MODE_KEY, defaultValue: 'wide' })])
    expect(await rules.evaluateScheduled()).toHaveLength(0) // 'wide' ⇒ 90 > 70
    expect(calls.at(-1)!.params.mode).toBe('wide')
    await db.close?.()
  })

  it('a number setting is unchanged: a stored name binds its default, a numeric string its number', async () => {
    const db = await boot()
    await seed(db, 'dev_1', 70)
    const named = engineOver(db, { stored: { [LEVEL_KEY]: 'wide' } })
    await named.rules.register([modeRule()])
    await named.rules.evaluateScheduled()
    expect(named.calls.at(-1)!.params.level).toBe(60)

    const numeric = engineOver(db, { stored: { [LEVEL_KEY]: '75' } })
    await numeric.rules.register([modeRule()])
    await numeric.rules.evaluateScheduled()
    expect(numeric.calls.at(-1)!.params.level).toBe(75)
    await db.close?.()
  })
})

describe('rawSqlSettings: a stored string is a value, never SQL', () => {
  /** Fires per reading on the device the stored setting names. */
  const DEVICE_BY_NAME_SQL = `
SELECT COUNT(*) AS observed_value, 0 AS threshold_value
FROM v_gauge
WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
  AND device_id = CAST($mode AS VARCHAR)
HAVING COUNT(*) > 0;`

  const byName = () => RuleSchema.parse({
    ...base,
    id: 'test.by-name',
    rawSql: DEVICE_BY_NAME_SQL,
    rawSqlSettings: { mode: { key: MODE_KEY, defaultValue: 'none' } },
  })

  it.each([
    ['a quote-breaking predicate', `dev_x' OR '1'='1`],
    ['a stacked statement', `'; DROP TABLE memory.gauge; --`],
    ['a comment tail', `dev_1' --`],
  ])('%s matches nothing and changes nothing', async (_label, payload) => {
    const db = await boot()
    await seed(db, 'dev_1', 70)
    await seed(db, 'dev_2', 70)
    const { rules, calls } = engineOver(db, { stored: { [MODE_KEY]: payload } })
    const rule = byName()
    await rules.register([rule])
    expect(await rules.evaluateScheduled()).toHaveLength(0)
    const call = calls.find(c => c.sql.includes('CAST($mode AS VARCHAR)'))!
    expect(call.sql).toBe(rule.rawSql) // the statement text is the rule's, untouched
    expect(call.params.mode).toBe(payload) // the payload travels as a parameter
    const [{ n }] = await db.execute<{ n: number }>(`SELECT COUNT(*) AS n FROM memory.gauge`)
    expect(Number(n)).toBe(2)
    await db.close?.()
  })

  it('an exact stored name matches as data', async () => {
    const db = await boot()
    await seed(db, 'dev_1', 70)
    const { rules } = engineOver(db, { stored: { [MODE_KEY]: 'dev_1' } })
    await rules.register([byName()])
    const [v] = await rules.evaluateScheduled()
    expect(v?.observedValue).toBe(1)
    await db.close?.()
  })
})

describe('rawSqlSettings: type', () => {
  it('is inferred from the default; a 0.63 entry is a number setting', () => {
    expect(rawSqlSettingType({ key: LEVEL_KEY, defaultValue: 60 })).toBe('number')
    expect(rawSqlSettingType({ key: MODE_KEY, defaultValue: 'normal' })).toBe('string')
    expect(rawSqlSettingType({ key: MODE_KEY, defaultValue: 'normal', type: 'string' })).toBe('string')
  })

  it('an explicit type must agree with the default', () => {
    expect(() => modeRule({ key: MODE_KEY, defaultValue: 1, type: 'string' })).toThrow(/type must match/)
    expect(() => modeRule({ key: MODE_KEY, defaultValue: 'normal', type: 'number' })).toThrow(/type must match/)
    expect(() => modeRule({ key: MODE_KEY, defaultValue: 'normal', type: 'enum' })).toThrow()
  })

  it('a string entry needs a registered string key; it need not be a threshold', () => {
    expect(() => validateRule(modeRule())).not.toThrow()
    expect(() => validateRule(modeRule({ key: LEVEL_KEY, defaultValue: 'normal' })))
      .toThrow(/not a registered string setting/)
    expect(() => validateRule(modeRule({ key: 'user:notARealKey', defaultValue: 'normal' })))
      .toThrow(RuleValidationError)
  })

  it('a number entry still needs a rule-readable key', () => {
    expect(() => validateRule(RuleSchema.parse({
      ...base,
      rawSql: 'SELECT $level',
      rawSqlSettings: { level: { key: MODE_KEY, defaultValue: 1 } },
    }))).toThrow(/not a rule-readable setting/)
  })
})

// ── $deviceId ──────────────────────────────────────────────────────────────

/** The last day's average on the scoped device, or every device when NULL. */
const DEVICE_SQL = `
SELECT AVG(level) AS observed_value, 60 AS threshold_value
FROM v_gauge
WHERE user_id = $userId AND brand = $brand AND family_id = $familyId
  AND (CAST($deviceId AS VARCHAR) IS NULL OR device_id = CAST($deviceId AS VARCHAR))
  AND ts > NOW() - INTERVAL 1 DAY
HAVING AVG(level) > 60;`

const deviceRule = () => RuleSchema.parse({ ...base, id: 'test.device', rawSql: DEVICE_SQL })

describe('rawSql reads $deviceId', () => {
  async function twoDevices(): Promise<DB> {
    const db = await boot()
    await seed(db, 'dev_1', 80)
    await seed(db, 'dev_2', 50)
    return db
  }

  it('scopes the rule to the device the provider names', async () => {
    const db = await twoDevices()
    const one = engineOver(db, { device: async () => 'dev_1' })
    await one.rules.register([deviceRule()])
    const [v] = await one.rules.evaluateScheduled()
    expect(v?.observedValue).toBe(80)
    expect(v?.evidence.deviceId).toBe('dev_1')
    expect(one.calls.at(-1)!.params.deviceId).toBe('dev_1')

    const two = engineOver(db, { device: async () => 'dev_2' })
    await two.rules.register([deviceRule()])
    expect(await two.rules.evaluateScheduled()).toHaveLength(0)
    await db.close?.()
  })

  it.each([
    ['no provider', undefined],
    ['the provider names none', async () => undefined],
    ['the provider returns an empty id', async () => ''],
    ['the provider throws', async () => { throw new Error('boom') }],
  ])('binds NULL when %s; the documented filter then reads every device', async (_label, device) => {
    const db = await twoDevices()
    const { rules, calls } = engineOver(db, device ? { device } : {})
    await rules.register([deviceRule()])
    const [v] = await rules.evaluateScheduled()
    expect(v?.observedValue).toBe(65) // (80 + 50) / 2
    expect(v?.evidence.deviceId).toBeNull()
    expect(calls.at(-1)!.params).toHaveProperty('deviceId', null)
    await db.close?.()
  })

  it('asks the provider once per user per pass', async () => {
    const db = await twoDevices()
    let asked = 0
    const { rules } = engineOver(db, { device: async () => { asked += 1; return 'dev_1' } })
    await rules.register([deviceRule(), { ...deviceRule(), id: 'test.device-2' }])
    await rules.evaluateScheduled()
    expect(asked).toBe(1)
    await db.close?.()
  })

  it('a rule that does not read it is not bound one and has no deviceId evidence', async () => {
    const db = await twoDevices()
    let asked = 0
    const { rules, calls } = engineOver(db, {
      stored: { [MODE_KEY]: 'narrow' },
      device: async () => { asked += 1; return 'dev_1' },
    })
    await rules.register([modeRule()])
    const [v] = await rules.evaluateScheduled()
    expect(asked).toBe(0)
    expect(calls.at(-1)!.params).not.toHaveProperty('deviceId')
    expect(v?.evidence).not.toHaveProperty('deviceId')
    await db.close?.()
  })
})

describe('$deviceId — compile', () => {
  it('is an allowed placeholder and marks the compiled rule', () => {
    const c = compileRule(deviceRule())
    expect(c.needsDeviceId).toBe(true)
    expect(c.needsTimezone).toBeUndefined()
  })

  it('is reserved: a setting may not take its name', () => {
    expect(() => compileRule(RuleSchema.parse({
      ...base,
      rawSql: 'SELECT $deviceId',
      rawSqlSettings: { deviceId: { key: MODE_KEY, defaultValue: 'x' } },
    }))).toThrow(/bound by the engine/)
  })

  it('binds on the fake engine without a provider (NULL)', async () => {
    const engine = createFakeEngine()
    const rules = createRulesEngine({
      analytics: engine,
      storage: createFakeStorage(),
      brand: BRAND,
      familyId: FAMILY,
      familyMembersProvider: async () => [USER],
    })
    await rules.register([RuleSchema.parse({ ...base, rawSql: 'SELECT $deviceId AS observed_value' })])
    await rules.evaluateScheduled()
    const call = engine.__calls.find(c => c.sql.includes('$deviceId'))!
    expect(call.params.deviceId).toBeNull()
  })
})

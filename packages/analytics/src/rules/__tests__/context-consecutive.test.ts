/**
 * Sprint 5 T-17 / T-18 / T-19 / T-20 — context, consecutive, user_setting,
 * and view targeting in the compiler.
 */

import { describe, expect, it } from 'vitest'

import { compileRule, emitContextJoin, USER_SETTING_PARAM } from '../compiler'
import { RuleSchema, RuleValidationError } from '../schema'
import { validateRule } from '../validator'

/** Parse through the schema so defaults (`context: 'any'`) apply. */
function rule(overrides: Record<string, unknown>) {
  return RuleSchema.parse({
    id: 'test.rule',
    name: 'Test',
    metric: 'spo2',
    window: '24h',
    aggregation: 'min',
    compare: 'less_than',
    severity: 'warn',
    target: { type: 'absolute', value: 90 },
    ...overrides,
  })
}

describe('T-20 — generated SQL targets union views', () => {
  it('reads v_{table}, never the raw catalogs', () => {
    const sql = compileRule(rule({})).sql
    expect(sql).toContain('FROM v_spo2 m')
    expect(sql).not.toContain('r2.default')
    expect(sql).not.toContain('local.spo2')
  })

  it('applies to the baseline CTE too', () => {
    const sql = compileRule(rule({
      metric: 'hrv_ms',
      aggregation: 'avg',
      target: { type: 'baseline_percent', windowDays: 7, percent: 70 },
    })).sql
    // Both the observation and the baseline must see the same rows, or a
    // just-flushed reading is compared against a baseline that excludes it.
    expect(sql.match(/FROM v_hrv m/g)).toHaveLength(2)
  })
})

describe('T-17 — emitContextJoin', () => {
  it('any → no join', () => {
    expect(emitContextJoin('any')).toBe('')
  })

  it('asleep → INNER JOIN v_sleep_session on the sample instant', () => {
    const join = emitContextJoin('asleep')
    expect(join).toContain('INNER JOIN v_sleep_session s')
    expect(join).toContain('m.ts BETWEEN s.ts_start AND s.ts_end')
  })

  it('resting → INNER JOIN v_activity on a zero-step minute', () => {
    const join = emitContextJoin('resting')
    expect(join).toContain('INNER JOIN v_activity a')
    expect(join).toContain(`a.ts = date_trunc('minute', m.ts)`)
    expect(join).toContain('a.steps = 0')
  })

  it('joins carry the full tenant triple, not just user_id', () => {
    // A join on user alone would match another brand's sleep sessions for
    // the same person on a multi-brand install.
    for (const context of ['asleep', 'resting'] as const) {
      const join = emitContextJoin(context)
      expect(join).toMatch(/\.user_id = m\.user_id/)
      expect(join).toMatch(/\.brand = m\.brand/)
      expect(join).toMatch(/\.family_id = m\.family_id/)
    }
  })

  it('context is a JOIN, not a post-filter', () => {
    // "SpO₂ during sleep" must aggregate over sleep samples only.
    const sql = compileRule(rule({ context: 'asleep' })).sql
    const fromIdx = sql.indexOf('FROM v_spo2 m')
    const joinIdx = sql.indexOf('INNER JOIN v_sleep_session')
    const whereIdx = sql.indexOf('WHERE m.user_id')
    expect(fromIdx).toBeLessThan(joinIdx)
    expect(joinIdx).toBeLessThan(whereIdx)
  })
})

describe('T-18 — consecutive', () => {
  it('consecutive 1 stays on the aggregate path', () => {
    // "any single breach" is already `min(...) < threshold`; a window
    // function would be strictly more expensive for the same answer.
    const sql = compileRule(rule({ consecutive: 1 })).sql
    expect(sql).toContain('MIN(m.spo2) AS observed_value')
    expect(sql).not.toContain('ROW_NUMBER')
  })

  it('omitted consecutive behaves as 1', () => {
    expect(compileRule(rule({})).sql).not.toContain('ROW_NUMBER')
  })

  it('consecutive >= 2 emits gaps-and-islands run detection', () => {
    const compiled = compileRule(rule({ consecutive: 3 }))
    expect(compiled.sql).toContain('ROW_NUMBER() OVER (ORDER BY ts)')
    expect(compiled.sql).toContain('PARTITION BY breached')
    expect(compiled.sql).toContain('GROUP BY run_key')
    expect(compiled.sql).toContain('HAVING COUNT(*) >= $consecutive')
    expect(compiled.params.consecutive).toBe(3)
  })

  it('reports the worst reading in the run, in the compare direction', () => {
    // A user-facing card should quote the worst value, not an average.
    expect(compileRule(rule({ consecutive: 3, compare: 'less_than' })).sql)
      .toContain('MIN(value) AS observed_value')
    expect(compileRule(rule({
      consecutive: 3,
      compare: 'greater_than',
      aggregation: 'max',
      metric: 'stress',
      window: '24h',
    })).sql).toContain('MAX(value) AS observed_value')
  })

  it('composes with context', () => {
    const sql = compileRule(rule({ consecutive: 3, context: 'asleep' })).sql
    expect(sql).toContain('INNER JOIN v_sleep_session')
    expect(sql).toContain('ROW_NUMBER')
  })

  it('rejects consecutive with a baseline target at compile AND validate', () => {
    // Baseline targets resolve per-window, not per-sample — there is no
    // correct query shape, so it fails loudly rather than emitting
    // something subtly wrong.
    const bad = rule({
      metric: 'hrv_ms',
      aggregation: 'avg',
      consecutive: 3,
      window: '7d',
      target: { type: 'baseline_percent', windowDays: 7, percent: 70 },
    })
    expect(() => validateRule(bad)).toThrow(RuleValidationError)
    expect(() => compileRule(bad)).toThrow(RuleValidationError)
  })
})

describe('T-19 — user_setting target', () => {
  it('emits a bound placeholder, never a literal threshold', () => {
    const compiled = compileRule(rule({
      target: { type: 'user_setting', key: 'user:spo2SafeLevel', defaultValue: 90 },
    }))
    expect(compiled.sql).toContain(`$${USER_SETTING_PARAM}`)
    // The compiled SQL is threshold-agnostic, so one cache entry serves
    // every user and survives the user changing their setting.
    expect(compiled.sql).not.toContain('90')
    expect(compiled.params).not.toHaveProperty(USER_SETTING_PARAM)
  })

  it('carries the key + default for the evaluator to bind', () => {
    const compiled = compileRule(rule({
      target: { type: 'user_setting', key: 'user:spo2SafeLevel', defaultValue: 90 },
    }))
    expect(compiled.userSettingKey).toBe('user:spo2SafeLevel')
    expect(compiled.userSettingDefault).toBe(90)
  })

  it('leaves the fields undefined for other target types', () => {
    const compiled = compileRule(rule({}))
    expect(compiled.userSettingKey).toBeUndefined()
    expect(compiled.userSettingDefault).toBeUndefined()
  })

  it('composes with consecutive', () => {
    const compiled = compileRule(rule({
      consecutive: 3,
      target: { type: 'user_setting', key: 'user:spo2SafeLevel', defaultValue: 90 },
    }))
    expect(compiled.sql).toContain('ROW_NUMBER')
    expect(compiled.sql).toContain(`$${USER_SETTING_PARAM}`)
  })
})

describe('T-21 — validator', () => {
  it('rejects a consecutive count the window cannot hold', () => {
    // 3 HRV samples at 60-min cadence need 180min; a 1h window holds one.
    // Without this the rule silently never fires.
    expect(() => validateRule(rule({
      metric: 'hrv_ms',
      aggregation: 'avg',
      window: '24h',
      consecutive: 100,
    }))).toThrow(/could never fire/)
  })

  it('allows a consecutive count that fits', () => {
    expect(() => validateRule(rule({ consecutive: 3 }))).not.toThrow()
  })

  it('rejects a context on a per-session metric', () => {
    expect(() => validateRule(rule({
      metric: 'sleep_total_minutes',
      window: '3d',
      aggregation: 'avg',
      context: 'asleep',
    }))).toThrow(/already a per-session measure/)
  })

  it('accepts the two shipped Ziva SpO₂ rules', async () => {
    const { zivaDefaults } = await import('../defaults')
    for (const id of ['ziva.spo2-safe-level', 'ziva.spo2-desaturation-asleep']) {
      const r = zivaDefaults.find(x => x.id === id)!
      expect(() => validateRule(r)).not.toThrow()
      expect(() => compileRule(r)).not.toThrow()
    }
  })
})

describe('injection safety holds across the new paths', () => {
  it('binds tenant params in every generated variant', () => {
    const variants = [
      rule({}),
      rule({ context: 'asleep' }),
      rule({ context: 'resting' }),
      rule({ consecutive: 3 }),
      rule({ consecutive: 3, context: 'asleep' }),
      rule({ target: { type: 'user_setting', key: 'user:x', defaultValue: 90 } }),
    ]
    for (const r of variants) {
      const sql = compileRule(r).sql
      expect(sql).toContain('$userId')
      expect(sql).toContain('$brand')
      expect(sql).toContain('$familyId')
    }
  })
})

describe('T-42 — user_setting keys must be in the KVStore registry', () => {
  const userSettingRule = (key: string) => rule({
    target: { type: 'user_setting', key, defaultValue: 90 },
  })

  it('accepts a registered threshold key', () => {
    expect(() => validateRule(userSettingRule('user:spo2SafeLevel')))
      .not.toThrow()
  })

  it('rejects an unregistered key', () => {
    // The failure this prevents: a typo compiles, validates, evaluates,
    // and silently uses defaultValue forever — the user drags their safe
    // level, sees it save, and nothing changes.
    expect(() => validateRule(userSettingRule('user:spo2SaveLevel')))
      .toThrow(/not in the KVStore key namespace registry/)
  })

  it('rejects a registered key that is UX state, not a threshold', () => {
    // Thresholding on "did they dismiss a banner" is a bug, not a feature.
    expect(() => validateRule(userSettingRule('user:spo2Day30BannerDismissed')))
      .toThrow(/UX state, not a threshold/)
  })

  it('names the legal keys in the error, so the fix is obvious', () => {
    try {
      validateRule(userSettingRule('user:nope'))
      throw new Error('should have thrown')
    }
    catch (err) {
      const msg = (err as Error).message
      expect(msg).toContain('user:spo2SafeLevel')
      expect(msg).toContain('KV_KEY_REGISTRY')
    }
  })

  it('leaves non-user_setting targets alone', () => {
    expect(() => validateRule(rule({}))).not.toThrow()
  })

  it('the shipped Ziva safe-level rule uses a registered key', async () => {
    const { zivaDefaults } = await import('../defaults')
    const r = zivaDefaults.find(x => x.id === 'ziva.spo2-safe-level')!
    expect(r.target).toMatchObject({ key: 'user:spo2SafeLevel' })
    expect(() => validateRule(r)).not.toThrow()
  })
})

/*
 * The two safety layers under every bounded reader (mongrov-packages#44).
 *
 *   attach    a macro missing in both forms turns `boundedReads` off, says
 *             why, and the rule evaluator then runs the view form.
 *   run time  a bounded statement that THROWS is retried as the view form in
 *             the same call (`executeBounded`), the connection's possible
 *             aborted transaction is absorbed first (zivaone_app#195), and a
 *             few such failures turn `boundedReads` off for the attach.
 */
import type { DuckDBInstance } from '../engine'
import type { AnalyticsEngine, AnalyticsLogger } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { createRulesEngine } from '../../rules/index'
import { BOUNDED_FAILURE_LIMIT, executeBounded } from '../bounded-read'
import { createAnalytics } from '../factory'
import { createFakeKV } from './__fakes__/fake-kv'

function recordingLogger() {
  const lines: { level: string, message: string, meta?: Record<string, unknown> }[] = []
  const at = (level: string) => (message: string, meta?: Record<string, unknown>) => lines.push({ level, message, meta })
  const logger: AnalyticsLogger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  return { logger, lines }
}

function fakeEngine(opts: { boundedReads?: boolean, failBounded?: boolean }) {
  const executed: string[] = []
  const report = vi.fn()
  const engine = {
    boundedReads: opts.boundedReads,
    reportBoundedReadFailure: report,
    async execute(sql: string) {
      executed.push(sql)
      if (opts.failBounded && sql.includes('_between('))
        throw new Error('Binder Error: boom')
      return [{ form: sql.includes('_between(') ? 'bounded' : 'view' }]
    },
  } as unknown as AnalyticsEngine
  return { engine, executed, report }
}

const FORMS = { bounded: 'SELECT * FROM v_x_clean_between(1, 2)', view: 'SELECT * FROM v_x_clean' }

describe('executeBounded', () => {
  it('runs the bounded form when the engine has every macro', async () => {
    const { engine, executed } = fakeEngine({ boundedReads: true })
    expect(await executeBounded(engine, FORMS, {})).toEqual([{ form: 'bounded' }])
    expect(executed).toEqual([FORMS.bounded])
  })

  it('runs the view form when the capability is false, absent, or there is no bounded form', async () => {
    for (const boundedReads of [false, undefined]) {
      const { engine, executed } = fakeEngine({ boundedReads })
      expect(await executeBounded(engine, FORMS, {})).toEqual([{ form: 'view' }])
      expect(executed).toEqual([FORMS.view])
    }
    const { engine, executed } = fakeEngine({ boundedReads: true })
    await executeBounded(engine, { view: FORMS.view }, {})
    expect(executed).toEqual([FORMS.view])
  })

  it('retries a throwing bounded form as the view form: reports, absorbs, answers', async () => {
    const { engine, executed, report } = fakeEngine({ boundedReads: true, failBounded: true })
    const failures: unknown[] = []
    expect(await executeBounded(engine, FORMS, {}, c => failures.push(c))).toEqual([{ form: 'view' }])
    expect(failures).toHaveLength(1)
    expect(report).toHaveBeenCalledTimes(1)
    // SELECT 1 between the two absorbs a poisoned connection before the retry.
    expect(executed).toEqual([FORMS.bounded, 'SELECT 1', FORMS.view])
  })

  it('still retries when the absorbing statement itself fails (it is meant to)', async () => {
    const executed: string[] = []
    let poisoned = false
    const engine = {
      boundedReads: true,
      async execute(sql: string) {
        executed.push(sql)
        if (poisoned) {
          poisoned = false
          throw new Error('TransactionException')
        }
        if (sql.includes('_between(')) {
          poisoned = true
          throw new Error('prepare failed')
        }
        return [{ ok: 1 }]
      },
    } as unknown as AnalyticsEngine
    expect(await executeBounded(engine, FORMS, {})).toEqual([{ ok: 1 }])
    expect(executed).toEqual([FORMS.bounded, 'SELECT 1', FORMS.view])
  })
})

async function boot(factory: () => Promise<DuckDBInstance>, logger?: AnalyticsLogger): Promise<AnalyticsEngine> {
  const { kv } = createFakeKV()
  const analytics = createAnalytics({ mode: 'local', storage: kv, retention: {}, logger }, { duckdbFactory: factory })
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (analytics.state === 'ready') { clearInterval(t); resolve() }
      if (analytics.lastError) { clearInterval(t); reject(analytics.lastError) }
    }, 10)
  })
  await analytics.attach({ brand: 'ziva', tenantScope: 'family', tenantId: 'u1', userId: 'u1' })
  return analytics
}

const SPO2_RULE = {
  id: 'test.spo2.low',
  name: 'SpO2 low',
  metric: 'spo2',
  window: '24h',
  aggregation: 'min',
  compare: 'less_than',
  severity: 'warn',
  target: { type: 'absolute', value: 90 },
} as const

describe('a real engine', () => {
  it('reports boundedReads=false, and why, when a macro fails in both forms; rules then run the views', async () => {
    const { logger, lines } = recordingLogger()
    // Fail v_spo2_q_between's real body AND its plain stand-in.
    const factory = async () => {
      const inst = await createRealDuckDB(['icu'])
      return {
        ...inst,
        execute: (sql: string, params?: Record<string, unknown>) => sql.includes('MACRO v_spo2_q_between(')
          ? Promise.reject(new Error('ParameterNotResolvedException'))
          : inst.execute(sql, params),
      }
    }
    const analytics = await boot(factory, logger)
    expect(analytics.boundedReads).toBe(false)
    const off = lines.find(l => l.message === 'analytics.attach.bounded_reads_off')
    expect(off?.meta?.macros).toEqual(['v_spo2_q_between'])
    expect(JSON.stringify(off?.meta?.errors)).toContain('ParameterNotResolvedException')

    await analytics.execute(`INSERT INTO spo2 (ts, brand, family_id, user_id, device_id, spo2)
      VALUES (CAST(now() AS TIMESTAMP) - INTERVAL 1 HOUR, 'ziva', 'u1', 'u1', 'ring', 85)`)
    const execute = vi.spyOn(analytics, 'execute')
    const rules = createRulesEngine({
      analytics,
      storage: createFakeKV().kv,
      familyMembersProvider: async () => ['u1'],
      brand: 'ziva',
      familyId: 'u1',
    })
    await rules.register([SPO2_RULE as never])
    const fired = await rules.evaluateScheduled()
    expect(fired.map(v => v.ruleId)).toEqual(['test.spo2.low'])
    const ruleSql = execute.mock.calls.map(c => c[0]).filter(s => s.includes('AS observed_value'))
    expect(ruleSql.length).toBeGreaterThan(0)
    expect(ruleSql.some(s => s.includes('_between('))).toBe(false)
    await analytics.close()
  }, 60_000)

  it(`turns boundedReads off after ${BOUNDED_FAILURE_LIMIT} run-time failures, until the next attach`, async () => {
    const { logger, lines } = recordingLogger()
    const analytics = await boot(() => createRealDuckDB(['icu']), logger)
    expect(analytics.boundedReads).toBe(true)
    for (let i = 0; i < BOUNDED_FAILURE_LIMIT - 1; i++) analytics.reportBoundedReadFailure!()
    expect(analytics.boundedReads).toBe(true)
    analytics.reportBoundedReadFailure!()
    expect(analytics.boundedReads).toBe(false)
    expect(lines.some(l => l.message === 'analytics.bounded_reads_downgraded')).toBe(true)

    await analytics.detach()
    await analytics.attach({ brand: 'ziva', tenantScope: 'family', tenantId: 'u1', userId: 'u1' })
    expect(analytics.boundedReads).toBe(true)
    await analytics.close()
  }, 60_000)

  it('a rule whose bounded statement throws still fires, from the views, and says so', async () => {
    const { logger: analyticsLogger } = recordingLogger()
    const analytics = await boot(() => createRealDuckDB(['icu']), analyticsLogger)
    await analytics.execute(`INSERT INTO spo2 (ts, brand, family_id, user_id, device_id, spo2)
      VALUES (CAST(now() AS TIMESTAMP) - INTERVAL 1 HOUR, 'ziva', 'u1', 'u1', 'ring', 85)`)
    // Every bounded statement fails at run time, as a shape the device's
    // build rejects would.
    const real = analytics.execute.bind(analytics)
    vi.spyOn(analytics, 'execute').mockImplementation(((sql: string, params?: Record<string, unknown>) =>
      sql.includes('_between(') ? Promise.reject(new Error('Binder Error: native only')) : real(sql, params)) as AnalyticsEngine['execute'])

    const warns: { message: string, meta?: Record<string, unknown> }[] = []
    const rules = createRulesEngine({
      analytics,
      storage: createFakeKV().kv,
      familyMembersProvider: async () => ['u1'],
      brand: 'ziva',
      familyId: 'u1',
      logger: { debug() {}, info() {}, warn: (message, meta) => warns.push({ message, meta }), error() {} },
    })
    await rules.register([SPO2_RULE as never])
    const fired = await rules.evaluateScheduled()
    expect(fired.map(v => v.ruleId)).toEqual(['test.spo2.low'])
    const failed = warns.filter(w => w.message === 'rules.bounded_failed')
    expect(failed).toHaveLength(1)
    expect(failed[0]!.meta).toMatchObject({ ruleId: 'test.spo2.low' })
    expect(String(failed[0]!.meta!.error)).toContain('native only')
    await analytics.close()
  }, 60_000)
})

/**
 * `engine.setQuality` (zivaone_app#474) — the motion-filter switch in
 * Settings, on a real in-memory DuckDB.
 *
 * Alerts follow what is shown (principle 69): the `_clean` views feed the
 * charts AND the rules, so a flipped filter has to rebuild them at once, not
 * at the next attach. These tests pin that a flip changes what `v_spo2_clean`
 * (and its bounded macro) return for a moving reading, that flipping back
 * restores it, that `boundedReads` is recomputed as attach computes it, that
 * a call before attach is what attach builds, and that the call is
 * serialised with attach and detach.
 */
import type { DuckDBInstance } from '../engine'
import type { AnalyticsConfig, AnalyticsEngine, AnalyticsLogger, AttachContext } from '../types'
import { describe, expect, it } from 'vitest'
import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { BOUNDED_FAILURE_LIMIT } from '../bounded-read'
import { AnalyticsError } from '../errors'
import { createAnalytics } from '../factory'
import { createFakeKV } from './__fakes__/fake-kv'

const CTX: AttachContext = { brand: 'ziva', tenantScope: 'family', tenantId: 'u1', userId: 'u1' }
const IDS = `'ziva', 'u1', 'u1', 'ring'`
const COLS = 'brand, family_id, user_id, device_id'
const READING = `TIMESTAMP '2026-09-10 09:00:00'`

function recordingLogger() {
  const lines: { level: string, message: string, meta?: Record<string, unknown> }[] = []
  const at = (level: string) => (message: string, meta?: Record<string, unknown>) => lines.push({ level, message, meta })
  const logger: AnalyticsLogger = { debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error') }
  return { logger, lines }
}

/**
 * A real DuckDB the test can also reach around the engine (to look at the
 * catalog after detach), and whose `v_spo2_q_between` macro can be made to
 * fail in both forms on demand.
 */
function rigFactory() {
  const handle: { inst?: DuckDBInstance, failMacro: boolean, sql: string[] } = { failMacro: false, sql: [] }
  const factory = async (): Promise<DuckDBInstance> => {
    const inst = await createRealDuckDB([])
    const wrapped: DuckDBInstance = {
      ...inst,
      execute: (sql: string, params?: Record<string, unknown>) => {
        handle.sql.push(sql)
        return handle.failMacro && sql.includes('MACRO v_spo2_q_between(')
          ? Promise.reject(new Error('ParameterNotResolvedException'))
          : inst.execute(sql, params)
      },
    }
    handle.inst = wrapped
    return wrapped
  }
  return { factory, handle }
}

async function untilReady(engine: AnalyticsEngine): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const t = setInterval(() => {
      if (engine.state === 'ready') { clearInterval(t); resolve() }
      if (engine.lastError) { clearInterval(t); reject(engine.lastError) }
    }, 10)
  })
}

async function boot(extra: Partial<AnalyticsConfig> = {}) {
  const { factory, handle } = rigFactory()
  const { logger, lines } = recordingLogger()
  const engine = createAnalytics(
    { mode: 'local', storage: createFakeKV().kv, retention: {}, logger, ...extra } as AnalyticsConfig,
    { duckdbFactory: factory },
  )
  await untilReady(engine)
  return { engine, handle, lines }
}

/** Worn, and plainly walking: 200 steps a few minutes either side. */
async function seedMovingReading(engine: AnalyticsEngine): Promise<void> {
  for (const iso of ['2026-09-10 08:00:00', '2026-09-10 09:00:00'])
    await engine.execute(`INSERT INTO temperature (ts, ${COLS}, temp_c) VALUES (TIMESTAMP '${iso}', ${IDS}, 36.5);`)
  await engine.execute(`INSERT INTO spo2 (ts, ${COLS}, spo2) VALUES (${READING}, ${IDS}, 97);`)
  for (const m of ['08:50', '08:55', '09:05'])
    await engine.execute(`INSERT INTO activity (ts, ${COLS}, steps) VALUES (TIMESTAMP '2026-09-10 ${m}:00', ${IDS}, 200);`)
}

async function shown(engine: AnalyticsEngine): Promise<{ view: number, macro: number }> {
  const view = await engine.execute<{ n: number | bigint }>(`SELECT count(*) AS n FROM v_spo2_clean WHERE ts = ${READING}`)
  const macro = await engine.execute<{ n: number | bigint }>(
    `SELECT count(*) AS n FROM v_spo2_clean_between(TIMESTAMP '2026-09-10 00:00:00', TIMESTAMP '2026-09-11 00:00:00') WHERE ts = ${READING}`,
  )
  return { view: Number(view[0]!.n), macro: Number(macro[0]!.n) }
}

describe('engine.setQuality (zivaone_app#474)', () => {
  it('a flip changes what the clean view and its macro return at once; flipping back restores it', async () => {
    const { engine, handle } = await boot()
    await engine.attach(CTX)
    await seedMovingReading(engine)
    // Default: motion filter off, so the moving reading is shown and counted.
    expect(await shown(engine)).toEqual({ view: 1, macro: 1 })

    const before = handle.sql.length
    await engine.setQuality({ motionFilter: true })
    expect(await shown(engine)).toEqual({ view: 0, macro: 0 })
    // Only the quality layer is rebuilt: the union views do not depend on it.
    const rebuilt = handle.sql.slice(before)
    expect(rebuilt.some(s => /VIEW v_spo2_clean AS/.test(s))).toBe(true)
    expect(rebuilt.some(s => /VIEW v_spo2 AS/.test(s))).toBe(false)

    await engine.setQuality({ motionFilter: false })
    expect(await shown(engine)).toEqual({ view: 1, macro: 1 })
    await engine.close()
  }, 60_000)

  it('replaces config.quality, not merges with it', async () => {
    const { engine } = await boot({ quality: { motionFilter: true } })
    await engine.attach(CTX)
    await seedMovingReading(engine)
    expect((await shown(engine)).view).toBe(0)
    await engine.setQuality({})
    expect((await shown(engine)).view).toBe(1)
    await engine.close()
  }, 60_000)

  it('recomputes boundedReads exactly as attach does', async () => {
    const { engine, handle, lines } = await boot()
    await engine.attach(CTX)
    expect(engine.boundedReads).toBe(true)

    // The macro now fails in both forms: the rebuild turns boundedReads off
    // and says why, as attach would.
    handle.failMacro = true
    await engine.setQuality({ motionFilter: true })
    expect(engine.boundedReads).toBe(false)
    const off = lines.filter(l => l.message === 'analytics.attach.bounded_reads_off')
    expect(off).toHaveLength(1)
    expect(off[0]!.meta?.macros).toEqual(['v_spo2_q_between'])

    // And back on once the macro builds again.
    handle.failMacro = false
    await engine.setQuality({ motionFilter: false })
    expect(engine.boundedReads).toBe(true)

    // A rebuild also starts the run-time failure count over, like attach.
    for (let i = 0; i < BOUNDED_FAILURE_LIMIT; i++) engine.reportBoundedReadFailure!()
    expect(engine.boundedReads).toBe(false)
    await engine.setQuality({ motionFilter: false })
    expect(engine.boundedReads).toBe(true)
    await engine.close()
  }, 60_000)

  it('before attach: stores only, and the attach builds with it', async () => {
    const { engine, handle } = await boot()
    const before = handle.sql.length
    await engine.setQuality({ motionFilter: true })
    // Nothing to rebuild yet, and no error: the app sets it from Settings at
    // startup, whenever that lands relative to attach.
    expect(handle.sql.slice(before).some(s => s.includes('v_spo2_clean'))).toBe(false)

    await engine.attach(CTX)
    await seedMovingReading(engine)
    expect(await shown(engine)).toEqual({ view: 0, macro: 0 })

    // And it survives a detach + re-attach.
    await engine.detach()
    await engine.attach(CTX)
    expect((await shown(engine)).view).toBe(0)
    await engine.close()
  }, 60_000)

  it('is serialised: concurrent calls apply in order, the last one wins', async () => {
    const { engine } = await boot()
    await engine.attach(CTX)
    await seedMovingReading(engine)
    await Promise.all([
      engine.setQuality({ motionFilter: true }),
      engine.setQuality({ motionFilter: false }),
      engine.setQuality({ motionFilter: true }),
    ])
    expect((await shown(engine)).view).toBe(0)
    await engine.close()
  }, 60_000)

  it('a call made while attach is in flight is not lost', async () => {
    const { engine } = await boot()
    const attaching = engine.attach(CTX)
    const setting = engine.setQuality({ motionFilter: true })
    await Promise.all([attaching, setting])
    await seedMovingReading(engine)
    expect((await shown(engine)).view).toBe(0)
    await engine.close()
  }, 60_000)

  it('a call racing detach never recreates the views the detach dropped', async () => {
    const { engine, handle } = await boot()
    await engine.attach(CTX)
    await Promise.all([engine.detach(), engine.setQuality({ motionFilter: true })])
    const left = await handle.inst!.execute<{ n: number | bigint }>(
      `SELECT count(*) AS n FROM duckdb_views() WHERE view_name IN ('v_spo2_q', 'v_spo2_clean')`,
    )
    expect(Number(left[0]!.n)).toBe(0)
    // Still stored for the next attach.
    await engine.attach(CTX)
    await seedMovingReading(engine)
    expect((await shown(engine)).view).toBe(0)
    await engine.close()
  }, 60_000)

  it('rejects with query_failed when a quality view cannot be built, and keeps the options', async () => {
    const { engine, handle } = await boot()
    await engine.attach(CTX)
    const real = handle.inst!.execute
    handle.inst!.execute = (sql, params) => sql.includes('VIEW v_spo2_clean AS')
      ? Promise.reject(new Error('boom'))
      : real(sql, params)
    const err = await engine.setQuality({ motionFilter: true }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AnalyticsError)
    expect((err as AnalyticsError).code).toBe('query_failed')
    handle.inst!.execute = real
    await engine.detach()
    await engine.attach(CTX)
    await seedMovingReading(engine)
    expect((await shown(engine)).view).toBe(0)
    await engine.close()
  }, 60_000)
})

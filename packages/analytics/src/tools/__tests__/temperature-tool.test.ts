/**
 * `getTemperature` (sprint6 T-07), executed against real DuckDB.
 *
 * The tool's output is text that lands in an LLM's context, so the things
 * worth pinning are about register and honesty rather than shape:
 *
 *   - it never prints more decimals than the ring measured
 *   - it degrades to "not established yet" rather than failing when the
 *     baseline is absent
 *   - its return path is guarded, and the sprint6 vocabulary is banned
 */
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../core/schemas'
import { BANNED_MEDICAL_VOCABULARY, findBanTerms } from '../formatters'
import { getTemperature } from '../impls/temperature'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const t of ['temperature', 'user_baseline'] as const) {
    await db.execute(
      LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`),
    )
  }
  await db.execute(
    generateViewDdl('temperature', { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }),
  )
  return db
}

function ctxFor(db: DB) {
  return { analytics: db, brand: BRAND, familyId: FAMILY } as never
}

async function seedDays(db: DB, days: number): Promise<void> {
  for (let d = 0; d < days; d++) {
    const day = new Date()
    day.setUTCDate(day.getUTCDate() - d)
    for (const [i, v] of [37, 37, 36].entries()) {
      await db.execute(
        `INSERT INTO memory.temperature (ts, brand, family_id, user_id, device_id, temp_c)
         VALUES (CAST($ts AS TIMESTAMP), $b, $f, $u, 'ring_1', $v)`,
        { ts: `${day.toISOString().slice(0, 10)} 1${i}:00:00`, b: BRAND, f: FAMILY, u: USER, v },
      )
    }
  }
}

describe('getTemperature', () => {
  it('prints no more decimals than the ring measured', async () => {
    const db = await boot()
    await seedDays(db, 3)

    const out = await getTemperature({ userId: USER, days: 7 }, ctxFor(db))

    // precisionFor('temp_c') is 1, so whole degrees. A "36.7" here would be
    // detail the hardware never produced — the daily mean is 36.67.
    expect(out.text).toMatch(/\d+°C/)
    expect(out.text).not.toMatch(/\d+\.\d+°C/)
    expect(out.rowCount).toBe(3)

    await db.close?.()
  })

  it('says the usual range is not established rather than omitting it', async () => {
    const db = await boot()
    await seedDays(db, 3)

    const out = await getTemperature({ userId: USER, days: 7 }, ctxFor(db))
    expect(out.text).toContain('not established yet')

    await db.close?.()
  })

  it('reports the usual range once a baseline exists', async () => {
    const db = await boot()
    await seedDays(db, 3)
    await db.execute(
      `INSERT INTO memory.user_baseline
         (brand, family_id, user_id, metric, window_days,
          p05, p10, p50, p90, p95, mean, stddev, sample_count, computed_at)
       VALUES ($b, $f, $u, 'temp_c', 30, 35, 36, 37, 38, 39, 37, 0.8, 25, now())`,
      { b: BRAND, f: FAMILY, u: USER },
    )

    const out = await getTemperature({ userId: USER, days: 7 }, ctxFor(db))
    expect(out.text).toContain('usual range: 36–38°C')
    expect(out.text).not.toContain('not established yet')

    await db.close?.()
  })

  it('returns a bounded message when there is no data', async () => {
    const db = await boot()
    const out = await getTemperature({ userId: USER, days: 7 }, ctxFor(db))

    expect(out.rowCount).toBe(0)
    expect(out.text).toContain('No temperature data')

    await db.close?.()
  })

  it('never editorialises — no verdict words in the output', async () => {
    const db = await boot()
    await seedDays(db, 3)

    const out = await getTemperature({ userId: USER, days: 7 }, ctxFor(db))
    // The tool reports and compares; deciding whether a temperature is high
    // is the rules engine's job, against a threshold the user configured.
    //
    // Verdict PHRASES, not bare words: the output legitimately says
    // "(low 36, high 37)" as labels for the daily min and max, which is
    // description rather than judgement. The first version of this test
    // banned "high" outright and failed on exactly that.
    const lower = out.text.toLowerCase()
    for (const phrase of ['fever', 'is high', 'too high', 'elevated', 'abnormal', 'concerning', 'you should'])
      expect(lower).not.toContain(phrase)

    await db.close?.()
  })

  it('is guarded by the copy rail on its return path', async () => {
    const db = await boot()
    await seedDays(db, 3)

    const out = await getTemperature({ userId: USER, days: 7 }, ctxFor(db))
    expect(findBanTerms(out.text)).toEqual([])

    await db.close?.()
  })
})

describe('sprint6 §6 vocabulary additions', () => {
  it('bans the temperature and HRV clinical terms', () => {
    for (const term of ['febrile', 'pyrexia', 'rmssd', 'sdnn', 'autonomic', 'sympathetic', 'parasympathetic', 'vagal', 'afib'])
      expect(BANNED_MEDICAL_VOCABULARY).toContain(term)
  })

  it('catches them case-insensitively, as an LLM would write them', () => {
    // The metric names are the realistic case: a model writes "RMSSD", not
    // "rmssd", and the list is lowercase.
    expect(findBanTerms('Your RMSSD is down')).toContain('rmssd')
    expect(findBanTerms('reduced vagal tone')).toContain('vagal')
    expect(findBanTerms('patient is febrile')).toContain('febrile')
  })

  it('leaves the register Ziva actually speaks alone', () => {
    expect(findBanTerms('You have been running warm for two days')).toEqual([])
  })
})

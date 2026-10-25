/*
 * With no join-reading gate in force, the clean views and macros read the
 * readings directly — and return exactly what the joined form returns
 * (zivaone_app#505).
 *
 * The reference is the `_q` view (or macro) with its clean predicate applied:
 * the joined form, which the direct one replaces only when `cleanNeedsJoins`
 * is false. Every combination of the five switches runs, so a direct
 * predicate that drifts from its `_q` twin on any one of them shows up as rows
 * on one side only. The fixture is the bounded suite's, built to put wear,
 * warm-up, motion and spike edges inside the windows.
 */
import type { QualityOptions, QualityTable } from '../../core/reading-quality'
import { describe, expect, it } from 'vitest'
import {
  cleanMacroFor,
  cleanNeedsJoins,
  cleanViewFor,
  QUALITY_FLAG_COLUMNS,
  QUALITY_TABLES,
  qualityMacroFor,
  qualityViewFor,
} from '../../core/reading-quality'
import { openSeeded, U, windows } from '../setup/quality-fixture'

const SWITCHES = ['wearFilter', 'warmUpFilter', 'rangeFilter', 'spikeFilter', 'motionFilter'] as const

/** All 32 settings of the five switches. */
function everyOption(): QualityOptions[] {
  return Array.from({ length: 2 ** SWITCHES.length }, (_, bits) =>
    Object.fromEntries(SWITCHES.map((k, i) => [k, (bits & (1 << i)) !== 0])) as QualityOptions)
}

/** The joined clean relation: the `_q` flags, the `_q` clean predicate. */
function joinedClean(table: QualityTable, from: string): string {
  const exclude = `EXCLUDE (${QUALITY_FLAG_COLUMNS[table].join(', ')})`
  if (table === 'hrv') {
    return `SELECT * ${exclude}
       REPLACE (CASE WHEN hrv_clean THEN hrv_ms END AS hrv_ms,
                CASE WHEN stress_clean THEN stress END AS stress)
      FROM ${from} WHERE hrv_clean OR stress_clean`
  }
  return `SELECT * ${exclude} FROM ${from} WHERE clean`
}

function symmetricDifference(a: string, b: string): string {
  return `SELECT count(*)::INTEGER AS n FROM ((${a} EXCEPT ALL ${b}) UNION ALL (${b} EXCEPT ALL ${a}))`
}

const label = (o: QualityOptions) => SWITCHES.map(k => `${k.replace('Filter', '')}=${o[k] ? 'on' : 'off'}`).join(' ')

describe('direct clean relations', () => {
  it.each(everyOption().map(o => [label(o), o] as const))(
    'match the joined form, views and macros — %s',
    async (_label, quality) => {
      const db = await openSeeded(quality)
      // Every 6th window keeps 32 settings affordable for the tables whose
      // flags are per-reading. Heart rate gets every window: its spike reads
      // the neighbours, and the few readings next to a spike are where the
      // slice pad matters — a 42-minute stride steps over them.
      const all = windows()
      const sampled = all.filter((_, i) => i % 6 === 0 || i >= all.length - 3)

      for (const table of QUALITY_TABLES) {
        const [view] = await db.execute<{ n: number }>(symmetricDifference(
          `SELECT * FROM ${cleanViewFor(table)}`,
          joinedClean(table, qualityViewFor(table)),
        ))
        let macroDiff = 0
        for (const [lo, hi] of table === 'heart_rate' ? all : sampled) {
          const [m] = await db.execute<{ n: number }>(symmetricDifference(
            `SELECT * FROM ${cleanMacroFor(table)}(${lo}, ${hi})`,
            joinedClean(table, `${qualityMacroFor(table)}(${lo}, ${hi})`),
          ))
          macroDiff += Number(m!.n)
        }
        // Same columns in the same order: `SELECT *` readers bind by position.
        const cols = async (rel: string) => (await db.execute<{ column_name: string }>(
          `SELECT column_name FROM (DESCRIBE ${rel})`,
        )).map(r => r.column_name)
        expect(await cols(`SELECT * FROM ${cleanViewFor(table)}`))
          .toEqual(await cols(joinedClean(table, qualityViewFor(table))))

        expect({ table, view: Number(view!.n), macroDiff }).toEqual({ table, view: 0, macroDiff: 0 })
      }
      await db.close()
    },
    900_000,
  )

  it('is what the app runs with: every gate a join feeds is off, so no clean read joins', () => {
    const app: QualityOptions = { motionFilter: false, wearFilter: false, warmUpFilter: false, rangeFilter: false, spikeFilter: false }
    for (const table of QUALITY_TABLES)
      expect({ table, joins: cleanNeedsJoins(table, app) }).toEqual({ table, joins: false })
  })

  it('the comparison can fail: the fixture has readings each switch excludes', async () => {
    // With every switch on, each one removes rows the all-off view keeps —
    // otherwise a predicate that ignored a switch would still match above.
    const off = await openSeeded({ wearFilter: false, warmUpFilter: false, rangeFilter: false, spikeFilter: false })
    const on = await openSeeded({ rangeFilter: true, spikeFilter: true })
    // The value column, not the row: an HRV row whose hrv_ms fails the clamp
    // stays for its stress, with hrv_ms nulled.
    const value: Record<QualityTable, string> = { heart_rate: 'bpm', hrv: 'hrv_ms', spo2: 'spo2', temperature: 'temp_c' }
    const count = async (db: typeof off, table: QualityTable) => Number((await db.execute<{ n: number }>(
      `SELECT count(${value[table]})::INTEGER AS n FROM ${cleanViewFor(table)} WHERE user_id = '${U}'`,
    ))[0]!.n)
    for (const table of QUALITY_TABLES)
      expect({ table, fewer: (await count(on, table)) < (await count(off, table)) }).toEqual({ table, fewer: true })
    await off.close()
    await on.close()
  }, 900_000)
})

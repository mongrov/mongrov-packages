/**
 * T-13's fixtures, driven end to end: firmware payload → mapper → warehouse.
 *
 * `schema.test.ts` proves the fixtures parse and stay byte-identical across
 * repos. That is governance, not use — a fixture nothing executes is a
 * document. These tests run each one through the real mapper and into real
 * DuckDB, so the scenario each fixture was authored for becomes an executable
 * claim rather than a sentence in its `$comment`.
 *
 * Both fixtures reason in UTC (`tz = 'UTC'`), matching their `$comment`s, so
 * a failure here is about mapping or aggregation rather than about timezone
 * conversion — which `timezone-matrix` and the day-cadence suite already cover
 * separately.
 */

import type { FirmwareExport, MapperContext } from '../types'
import { readFileSync } from 'node:fs'

import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createRealDuckDB } from '../../../__integration__/setup/real-engine'
import { generateViewDdl, LOCAL_SCHEMAS } from '../../../core/schemas'
import { mapFirmwareExport } from '../firmware'

const BRAND = 'ziva'
const FAMILY = 'fam_test'
const USER = 'user_alice'

const ctx: MapperContext = {
  brand: BRAND,
  familyId: FAMILY,
  userId: USER,
  deviceId: 'ring_8047',
  userTimezone: 'UTC',
}

// The fixtures are dated 2026-08-12; `now` sits just after so nothing is
// filtered as future-dated.
const NOW = new Date('2026-08-13T00:00:00.000Z')

function loadFixture(name: string): FirmwareExport {
  return JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf-8'))
}

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

let db: DB

/**
 * Literals, not bound parameters.
 *
 * A bare `$col` in an INSERT VALUES list has no surrounding SQL to infer a
 * type from, and DuckDB rejects it with "Cannot create values of type ANY" —
 * the same unresolvable-parameter class as zivaone_app#70, surfacing here in a
 * third client. Fixture data is trusted test input, so literals are the honest
 * fix; casting every column would mean restating the schema.
 */
function toLiteral(value: unknown): string {
  if (value === null || value === undefined)
    return 'NULL'
  if (value instanceof Date)
    return `TIMESTAMP '${value.toISOString().replace('T', ' ').replace('Z', '')}'`
  if (typeof value === 'number')
    return String(value)
  if (typeof value === 'boolean')
    return value ? 'TRUE' : 'FALSE'
  return `'${String(value).replace(/'/g, '\'\'')}'`
}

async function insertRows(table: string, rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) {
    const cols = Object.keys(row)
    const values = cols.map(c => toLiteral(row[c])).join(', ')
    await db.execute(
      `INSERT INTO memory.${table} (${cols.join(', ')}) VALUES (${values})`,
    )
  }
}

beforeAll(async () => {
  db = await createRealDuckDB(['icu'])
  for (const t of ['hrv', 'temperature'] as const) {
    await db.execute(
      LOCAL_SCHEMAS[t].replace(`CREATE TABLE ${t}`, `CREATE TABLE memory.${t}`),
    )
    await db.execute(
      generateViewDdl(t, { brand: BRAND, familyId: FAMILY, localCatalog: 'memory' }),
    )
  }
}, 120_000)

afterAll(async () => {
  await db?.close?.()
})

describe('firmware-whole-degree-temp — the T-08 precision case', () => {
  beforeAll(async () => {
    const batch = mapFirmwareExport(loadFixture('firmware-whole-degree-temp.json'), ctx, { now: NOW })
    await insertRows('temperature', batch.temperature as Record<string, unknown>[])
  }, 60_000)

  it('maps every reading through to the warehouse', async () => {
    const rows = await db.execute<{ n: number }>(
      `SELECT count(*)::INTEGER AS n FROM v_temperature WHERE user_id = $u`,
      { u: USER },
    )
    expect(Number(rows[0].n)).toBe(24)
  })

  it('stores whole degrees — the hardware emits no fraction', async () => {
    const rows = await db.execute<{ frac: number }>(
      `SELECT count(*)::INTEGER AS frac FROM v_temperature
       WHERE user_id = $u AND temp_c <> floor(temp_c)`,
      { u: USER },
    )
    expect(Number(rows[0].frac)).toBe(0)
  })

  /**
   * The fixture's `$comment` claims two different flag levels select identical
   * rows. This asserts it rather than trusting the sentence.
   *
   * This is exactly why `temp_c` is `DECIMAL(4,1)` and not `INTEGER`: the
   * column type is not the problem, the DATA is. Widening the column was
   * necessary but not sufficient — until the hardware emits fractions, a
   * user-settable flag level across 37.2–38.1 has two reachable states, not a
   * range, and that is a hardware go/no-go rather than a code fix.
   */
  it('proves 37.2 and 37.9 select IDENTICAL rows', async () => {
    const at = async (threshold: number) => {
      const rows = await db.execute<{ ts: string }>(
        `SELECT ts::VARCHAR AS ts FROM v_temperature
         WHERE user_id = $u AND temp_c > CAST($t AS DECIMAL(4,1)) ORDER BY ts`,
        { u: USER, t: threshold },
      )
      return rows.map(r => r.ts)
    }
    const low = await at(37.2)
    const high = await at(37.9)

    expect(low).toEqual(high)
    // And non-empty, or the equality would be vacuous.
    expect(low.length).toBeGreaterThan(0)
  })

  it('DOES separate thresholds that straddle a whole degree', async () => {
    // The control is not useless everywhere — 36.5 and 37.5 do differ. Without
    // this the test above would be consistent with "the filter never works".
    const count = async (threshold: number) => {
      const rows = await db.execute<{ n: number }>(
        `SELECT count(*)::INTEGER AS n FROM v_temperature
         WHERE user_id = $u AND temp_c > CAST($t AS DECIMAL(4,1))`,
        { u: USER, t: threshold },
      )
      return Number(rows[0].n)
    }
    expect(await count(36.5)).toBeGreaterThan(await count(37.5))
  })
})

describe('firmware-hrv-full-day — the T-04 day-cadence case', () => {
  beforeAll(async () => {
    const batch = mapFirmwareExport(loadFixture('firmware-hrv-full-day.json'), ctx, { now: NOW })
    await insertRows('hrv', batch.hrv as Record<string, unknown>[])
  }, 60_000)

  it('maps a full day of readings', async () => {
    const rows = await db.execute<{ n: number }>(
      `SELECT count(*)::INTEGER AS n FROM v_hrv WHERE user_id = $u AND hrv_ms IS NOT NULL`,
      { u: USER },
    )
    expect(Number(rows[0].n)).toBe(24)
  })

  /**
   * Every day-scoped aggregate in the registry and the rules layer drops days
   * with fewer than six readings. A fixture authored for day-cadence work that
   * could not clear that floor would be silently useless.
   */
  it('clears the >= 6-readings-per-day floor', async () => {
    const rows = await db.execute<{ day: string, n: number }>(
      `SELECT date_trunc('day', timezone('UTC', timezone('UTC', ts)))::VARCHAR AS day,
              count(*)::INTEGER AS n
       FROM v_hrv WHERE user_id = $u AND hrv_ms IS NOT NULL
       GROUP BY 1 HAVING count(*) >= 6`,
      { u: USER },
    )
    expect(rows).toHaveLength(1)
    expect(Number(rows[0].n)).toBe(24)
  })

  it('carries the stress column that shares this table', async () => {
    // hrv_table feeds both metrics; a mapper that dropped stress would leave
    // vital.hourPattern and the stress vertical without data.
    const rows = await db.execute<{ n: number }>(
      `SELECT count(*)::INTEGER AS n FROM v_hrv WHERE user_id = $u AND stress IS NOT NULL`,
      { u: USER },
    )
    expect(Number(rows[0].n)).toBe(24)
  })
})

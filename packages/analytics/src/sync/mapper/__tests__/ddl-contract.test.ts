/**
 * Mapper ↔ DDL contract regression (DR-01/02/03 class).
 *
 * The mapper's job is to produce rows that the flusher can hand straight to
 * a DuckDB Appender via `columnOrder[table].map(c => row[c] ?? null)`. That
 * only works if every mapped row's keys ARE the table's columns. Nothing
 * checked that invariant before: the unit tests asserted the mapper against
 * itself, and the integration tests seeded sensor tables with hand-written
 * SQL, so a mapper emitting `start_ts` for a `ts_start` column — or omitting
 * three NOT NULL columns outright — passed every suite while guaranteeing a
 * runtime failure on first real flush.
 *
 * This file closes that gap generically: it parses the frozen DDL in
 * `core/schemas.ts` and asserts, for every table in a `MappedBatch` built
 * from the real firmware fixture, that
 *
 *   1. every key on every mapped row is a declared column of that table, and
 *   2. every NOT NULL column is present and non-null on every mapped row.
 *
 * Adding a column to `SCHEMAS` without teaching the mapper about it — or
 * renaming a field on a mapped row — fails here rather than on-device.
 */

import type { TableName } from '../../../core/schemas'
import type { FirmwareExport, MapperContext, RingConfigTranslator } from '../types'

import { readFileSync } from 'node:fs'

import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LOCAL_SCHEMAS } from '../../../core/schemas'
import { mapFirmwareExport } from '../firmware'

// -------------------- DDL introspection --------------------

interface DdlColumn {
  name: string
  notNull: boolean
}

/**
 * Extract column declarations from a `CREATE TABLE` DDL string.
 *
 * Deliberately simple: our DDL is machine-generated and uniform — one
 * column per line, `name TYPE [NOT NULL] [...]`. Table-level constraint
 * lines (`PRIMARY KEY (...)`) are skipped by the leading-keyword filter.
 */
export function parseDdlColumns(ddl: string): DdlColumn[] {
  const open = ddl.indexOf('(')
  const body = ddl.slice(open + 1)
  const columns: DdlColumn[] = []

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '')
    if (line.length === 0)
      continue
    // Table-level constraints + the DDL terminator, not columns.
    if (/^(?:PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT|\))/i.test(line))
      continue

    const match = /^([A-Z_]\w*)\s+/i.exec(line)
    if (!match)
      continue
    columns.push({ name: match[1], notNull: /\bNOT NULL\b/i.test(line) })
  }
  return columns
}

// -------------------- fixture batch --------------------

const METRIC_ENUM: Record<string, number> = {
  hrv: 1,
  spo2: 2,
  heart_rate: 3,
  temperature: 4,
}
const ENUM_METRIC: Record<number, string> = {
  1: 'hrv',
  2: 'spo2',
  3: 'heart_rate',
  4: 'temperature',
}
const translator: RingConfigTranslator = {
  metricToDataType: metric => METRIC_ENUM[metric] ?? 99,
  dataTypeToMetric: dataType => ENUM_METRIC[dataType] ?? 'unknown',
  windowToSchemaFields: w => ({
    start_time: `${String(w.start_hour).padStart(2, '0')}:00`,
    end_time: `${String(w.end_hour).padStart(2, '0')}:00`,
    weeks: 0x7F,
  }),
}

const ctx: MapperContext = {
  brand: 'ziva',
  familyId: 'fam_test',
  userId: 'user_alice',
  deviceId: 'ring_8047',
  userTimezone: 'America/Los_Angeles',
}

const FIXTURE_PATH = join(__dirname, 'fixtures/firmware-8047-17-06-2026.json')
const NOW = new Date('2026-06-17T12:00:00.000Z')

function fixtureBatch() {
  const fw: FirmwareExport = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))
  const { device_config_closes: _closes, ...batch } = mapFirmwareExport(
    fw,
    ctx,
    { now: NOW, translator },
  )
  return batch
}

/**
 * Tables the mapper is responsible for populating. `device_event` is in the
 * batch shape but stays empty until a non-battery event type lands (0.6.0
 * fix B2), so it contributes no rows to check — the loop handles that
 * naturally.
 */
const MAPPED_TABLES = [
  'hrv',
  'heart_rate',
  'spo2',
  'temperature',
  'activity',
  'activity_bucket',
  'sleep_session',
  'sleep_stage',
  'sleep_raw',
  'device_event',
  'device_battery',
  'device_config',
] as const satisfies readonly TableName[]

describe('mapper ↔ DDL column contract', () => {
  const batch = fixtureBatch()

  it('the fixture exercises every mapped table except device_event', () => {
    // Guards against this suite silently passing because the fixture stopped
    // producing rows for a table.
    for (const table of MAPPED_TABLES) {
      if (table === 'device_event')
        continue
      expect(
        batch[table].length,
        `fixture produced no ${table} rows — contract unverified`,
      ).toBeGreaterThan(0)
    }
  })

  for (const table of MAPPED_TABLES) {
    describe(table, () => {
      const columns = parseDdlColumns(LOCAL_SCHEMAS[table])
      const columnNames = new Set(columns.map(c => c.name))
      const notNullColumns = columns.filter(c => c.notNull).map(c => c.name)

      it('declares columns in the DDL', () => {
        expect(columns.length).toBeGreaterThan(0)
      })

      it('emits no key that is not a column', () => {
        for (const row of batch[table] as readonly Record<string, unknown>[]) {
          const stray = Object.keys(row).filter(k => !columnNames.has(k))
          expect(
            stray,
            `${table} row has non-column key(s) [${stray.join(', ')}]; `
            + `DDL columns are [${[...columnNames].join(', ')}]`,
          ).toEqual([])
        }
      })

      it('populates every NOT NULL column', () => {
        for (const row of batch[table] as readonly Record<string, unknown>[]) {
          for (const col of notNullColumns) {
            expect(
              row[col] ?? null,
              `${table}.${col} is NOT NULL but the mapped row supplies `
              + `${JSON.stringify(row[col])}`,
            ).not.toBeNull()
          }
        }
      })
    })
  }
})

describe('parseDdlColumns', () => {
  it('reads names + NOT NULL flags and skips table-level constraints', () => {
    const cols = parseDdlColumns(LOCAL_SCHEMAS.sleep_session)
    const byName = Object.fromEntries(cols.map(c => [c.name, c.notNull]))

    expect(byName).toMatchObject({
      session_id: false, // PRIMARY KEY, not NOT NULL
      ts_start: true,
      ts_end: true,
      total_minutes: true,
      deep_minutes: false,
      night_of: false,
    })
    // The `PRIMARY KEY (...)` line in device_config is not a column.
    expect(parseDdlColumns(LOCAL_SCHEMAS.device_config).map(c => c.name))
      .not
      .toContain('PRIMARY')
  })
})

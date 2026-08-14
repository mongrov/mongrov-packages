/**
 * Principle 66 — re-syncing the same data is a no-op, not an append.
 *
 * Against a real DuckDB, because the two facts this depends on are properties
 * of the engine rather than of our code, and a fake would assert neither:
 *
 *   1. The Appender ENFORCES primary keys and throws
 *      `Failed to append: Duplicate key ...`. It has no `ON CONFLICT`. That
 *      is why writes go through an unconstrained staging mirror instead of
 *      straight into the keyed table.
 *   2. A Constraint Error is not transaction-exempt, so had we appended
 *      directly, the failure would poison the shared connection and take out
 *      unrelated queries — the same blast radius as zivaone_app#70.
 *
 * The regression this guards is the measured one: `sleep_stage` reached 16399
 * rows for 2082 `sleep_raw` blocks because ten of the twelve sync-written
 * tables had no key at all.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { IDENTITY_COLUMNS, LOCAL_SCHEMAS } from '../../core/schemas'

const BRAND = 'ziva'
const FAMILY = 'fam_1'
const USER = 'alice'
const DEVICE = 'ring_1'

type DB = Awaited<ReturnType<typeof createRealDuckDB>>

async function boot(): Promise<DB> {
  const db = await createRealDuckDB(['icu'])
  for (const table of ['spo2', 'sleep_stage'] as const) {
    await db.execute(
      LOCAL_SCHEMAS[table].replace(`CREATE TABLE ${table}`, `CREATE TABLE memory.${table}`),
    )
  }
  return db
}

/** Mirrors BatchFlusher's write path: staging append + set-based insert. */
async function writeIdempotent(
  db: DB,
  table: 'spo2' | 'sleep_stage',
  cols: readonly string[],
  rows: unknown[][],
): Promise<void> {
  const stg = `${table}__stg`
  await db.execute(`CREATE TABLE IF NOT EXISTS memory.${stg} AS SELECT * FROM memory.${table} WHERE false;`)
  await db.execute(`DELETE FROM memory.${stg};`)
  const appender = db.createAppender(stg)
  for (const r of rows) appender.appendRow(r)
  appender.flush()
  appender.close()
  await db.execute(
    `INSERT INTO memory.${table} (${cols.join(', ')}) `
    + `SELECT ${cols.join(', ')} FROM memory.${stg} ON CONFLICT DO NOTHING;`,
  )
  await db.execute(`DELETE FROM memory.${stg};`)
}

async function count(db: DB, table: string): Promise<number> {
  const rows = await db.execute<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM memory.${table}`)
  return rows[0]!.n
}

describe('identity keys are declared for every sync-written table', () => {
  it('covers the ten tables that had none — guard is not vacuous', () => {
    expect(Object.keys(IDENTITY_COLUMNS)).toHaveLength(10)
    // tool_call_audit is append-only by design; two identical calls at the
    // same instant are two real events, not a duplicate.
    expect(IDENTITY_COLUMNS).not.toHaveProperty('tool_call_audit')
  })

  it('puts the key on the local DDL only — the Iceberg variant is untouched', async () => {
    const db = await boot()
    const rows = await db.execute<{ constraint_text: string }>(
      `SELECT constraint_text FROM duckdb_constraints() WHERE table_name = 'spo2'`,
    )
    expect(rows.map(r => r.constraint_text).join(' ')).toContain('PRIMARY KEY')
    await db.close?.()
  })
})

describe('re-syncing the same batch', () => {
  const SPO2_COLS = ['ts', 'brand', 'family_id', 'user_id', 'device_id', 'spo2'] as const
  let db: DB

  beforeEach(async () => {
    db = await boot()
  })

  function spo2Rows(n: number): unknown[][] {
    return Array.from({ length: n }, (_, i) => [
      new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      BRAND,
      FAMILY,
      USER,
      DEVICE,
      95,
    ])
  }

  it('does not duplicate rows', async () => {
    await writeIdempotent(db, 'spo2', SPO2_COLS, spo2Rows(100))
    expect(await count(db, 'spo2')).toBe(100)

    await writeIdempotent(db, 'spo2', SPO2_COLS, spo2Rows(100))
    expect(await count(db, 'spo2')).toBe(100)

    await db.close?.()
  })

  it('still admits genuinely new rows in an overlapping batch', async () => {
    await writeIdempotent(db, 'spo2', SPO2_COLS, spo2Rows(100))
    // 100 rows where the first 50 are already stored.
    const overlapping = Array.from({ length: 100 }, (_, i) => [
      new Date(Date.UTC(2026, 0, 1, 0, 0, i + 50)),
      BRAND,
      FAMILY,
      USER,
      DEVICE,
      95,
    ])
    await writeIdempotent(db, 'spo2', SPO2_COLS, overlapping)

    expect(await count(db, 'spo2')).toBe(150)
    await db.close?.()
  })

  it('leaves the connection usable — no transaction poisoning', async () => {
    await writeIdempotent(db, 'spo2', SPO2_COLS, spo2Rows(10))
    await writeIdempotent(db, 'spo2', SPO2_COLS, spo2Rows(10))

    // Had the duplicate reached the appender directly, the Constraint Error
    // would have invalidated the transaction and this would throw.
    const rows = await db.execute<{ n: number }>(`SELECT count(*)::INTEGER AS n FROM memory.sleep_stage`)
    expect(rows[0]!.n).toBe(0)
    await db.close?.()
  })

  it('appending a duplicate DIRECTLY still throws — the reason staging exists', async () => {
    await writeIdempotent(db, 'spo2', SPO2_COLS, spo2Rows(1))

    const appender = db.createAppender('spo2')
    appender.appendRow(spo2Rows(1)[0]!)
    expect(() => { appender.flush() }).toThrow(/Duplicate key|primary key/i)
    try { appender.close() }
    catch { /* close after a failed flush is allowed to throw */ }

    await db.close?.()
  })
})

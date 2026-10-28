/**
 * The edge-case warehouse the quality equivalence suites run on. Why each day
 * is shaped the way it is: `bounded-quality-equivalence.test.ts`.
 */
import type { QualityOptions } from '../../core/reading-quality'
import { HybridDuckDB } from '../../core/engine'
import { LOCAL_SCHEMAS, TABLE_NAMES } from '../../core/schemas'
import { createViews } from '../../core/warehouse'
import { createRealDuckDB } from './real-engine'

export const B = 'ziva'
export const F = 'fam_1'
export const U = 'u1'
const U2 = 'u2'
const DAYS = 2
const day0 = Date.UTC(2026, 5, 1)
const iso = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')
export const at = (minute: number) => `TIMESTAMP '${iso(day0 + minute * 60_000)}'`

/** Minute of the day for generated row `g` at `step` minutes. */
const MOD = (step: number) => `((g * ${step}) % 1440)`

export async function openSeeded(quality: QualityOptions = {}): Promise<HybridDuckDB> {
  const db = new HybridDuckDB(() => createRealDuckDB(['icu']))
  await db.open()
  for (const t of TABLE_NAMES) await db.execute(LOCAL_SCHEMAS[t])

  const T0 = `TIMESTAMP '${iso(day0)}'`
  const every = (step: number) => `generate_series(0, ${(DAYS * 1440) / step - 1}) AS t(g)`

  // ── user 1, ring_1 ─────────────────────────────────────────────────────
  await db.execute(`INSERT INTO temperature (ts, brand, family_id, user_id, device_id, temp_c)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN ${MOD(5)} < 60 THEN 22.0
           WHEN ${MOD(5)} BETWEEN 900 AND 929 THEN 22.0
           WHEN ${MOD(5)} = 700 THEN 365.0
           ELSE 36.5 END
    FROM ${every(5)}
    WHERE ${MOD(5)} NOT BETWEEN 60 AND 149`)

  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 211 = 0 THEN 20
           WHEN g % 97 = 0 THEN 150
           ELSE 60 + (g % 20) END
    FROM ${every(5)}
    -- No heart rate while the ring reads ambient, as on a real ring: heart rate
    -- is wear evidence (#482). The edges land a reading exactly
    -- WEAR_HR_EVIDENCE_MINUTES from the nearest heart rate (905, 920; 1445, 1490).
    WHERE NOT (${MOD(5)} < 60 OR ${MOD(5)} BETWEEN 900 AND 929)`)
  // An implausible heart rate inside the dip is not wear evidence: 910-915 stay off-wrist.
  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (d * 1440 + 913) MINUTE, '${B}','${F}','${U}','ring_1', 20
    FROM generate_series(0, ${DAYS - 1}) AS t(d)`)

  await db.execute(`INSERT INTO hrv (ts, brand, family_id, user_id, device_id, hrv_ms, stress)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 113 = 0 THEN 0 ELSE 40 + (g % 30) END,
      CASE WHEN g % 89 = 0 THEN NULL ELSE 20 + (g % 50) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO spo2 (ts, brand, family_id, user_id, device_id, spo2)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 131 = 0 THEN 60 ELSE 94 + (g % 5) END
    FROM ${every(5)}`)

  await db.execute(`INSERT INTO activity (ts, brand, family_id, user_id, device_id, steps)
    SELECT ${T0} + INTERVAL (g) MINUTE, '${B}','${F}','${U}','ring_1',
      CASE WHEN g % 240 < 10 THEN 40
           WHEN ${MOD(1)} BETWEEN 155 AND 164 THEN 40
           WHEN g % 97 < 3 THEN 2
           ELSE 0 END
    FROM ${every(1)}`)

  // ── user 2, ring_2: walking constantly ──────────────────────────────────
  await db.execute(`INSERT INTO activity (ts, brand, family_id, user_id, device_id, steps)
    SELECT ${T0} + INTERVAL (g) MINUTE, '${B}','${F}','${U2}','ring_2', 100
    FROM ${every(1)}`)
  await db.execute(`INSERT INTO temperature (ts, brand, family_id, user_id, device_id, temp_c)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U2}','ring_2', 36.5
    FROM ${every(5)}`)
  await db.execute(`INSERT INTO heart_rate (ts, brand, family_id, user_id, device_id, bpm)
    SELECT ${T0} + INTERVAL (g * 5) MINUTE, '${B}','${F}','${U2}','ring_2', 110
    FROM ${every(5)}`)

  await createViews(db, { brand: B, familyId: F, localCatalog: 'memory', quality })
  return db
}

/** Every window the check runs over: 60 minutes, stepped every 7, plus whole-history edges. */
export function windows(): [string, string][] {
  const out: [string, string][] = []
  for (let off = 1440; off < 2 * 1440; off += 7)
    out.push([at(off), at(off + 60)])
  // A window starting at the very first row — no history to pad into.
  out.push([at(0), at(60)])
  // One whole day, and all of it.
  out.push([at(1440), at(2 * 1440)])
  out.push([at(0), at(2 * 1440)])
  return out
}

/**
 * Sleep correction — orchestration (v3.1's AppContextProvider loop, per night).
 *
 * Engine-agnostic: anything with `execute(sql)` returning rows. The relation
 * names select where the raw firmware shapes come from — staging views over
 * the warehouse in production, capture tables in the parity harness.
 *
 * NOT wired into sync yet (sleep-correction tasks §3): nothing calls this on
 * a device, so the mapper path is unchanged until that lands.
 */

import type { ClassifiedRow, Phase2Row, VitalSample } from './classify'
import type { SleepRelations } from './sql'
import { classifyBlocks } from './classify'
import {
  correctNightSql,
  DEFAULT_RELATIONS,
  detectHrTierSql,
  globalBaselinesSql,
  hasSleepDataSql,
  morningVitalsSql,
} from './sql'

export interface SqlRunner {
  execute: (sql: string) => Promise<unknown[]>
}

type Row = Record<string, unknown>

/** DuckDB hands BIGINT/HUGEINT back as bigint; every consumer here wants number. */
function toNum(v: unknown): number | null {
  if (v == null)
    return null
  if (typeof v === 'bigint')
    return Number(v)
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** v3.1 fallbacks when a scalar cannot be computed (AppContextProvider). */
export const TIER_FALLBACK = 5
export const P90_FALLBACK = 120
export const P75_FALLBACK = 80

export async function detectHrTier(db: SqlRunner, r: SleepRelations = DEFAULT_RELATIONS): Promise<number> {
  const [row] = (await db.execute(detectHrTierSql(r))) as Row[]
  return toNum(row?.hr_interval_minutes) || TIER_FALLBACK
}

export async function globalBaselines(
  db: SqlRunner,
  cutoffEpoch: number,
  r: SleepRelations = DEFAULT_RELATIONS,
): Promise<{ p75: number, p90: number }> {
  const [row] = (await db.execute(globalBaselinesSql(cutoffEpoch, r))) as Row[]
  return {
    p90: toNum(row?.p90_global) ?? P90_FALLBACK,
    p75: toNum(row?.p75_global) ?? P75_FALLBACK,
  }
}

export interface CorrectNightInput {
  windowStart: number
  windowEnd: number
  hrIntervalMin: number
  p75: number
  p90: number
  /** Offset in force for this night (the caller derives it from the IANA zone). */
  tzOffsetHours: number
  relations?: SleepRelations
}

export type CorrectNightResult
  = | { status: 'no_firmware_sleep' }
    | { status: 'no_phase2_rows' }
    | { status: 'ok', rows: ClassifiedRow[], vitals: VitalSample[] }

/** One night: guard → Phase 2 (SQL) → morning vitals → Phase 3 (JS). */
export async function correctNight(db: SqlRunner, input: CorrectNightInput): Promise<CorrectNightResult> {
  const r = input.relations ?? DEFAULT_RELATIONS
  const { windowStart, windowEnd } = input

  const [guard] = (await db.execute(hasSleepDataSql(windowStart, windowEnd, r))) as Row[]
  if (!toNum(guard?.has_data))
    return { status: 'no_firmware_sleep' }

  const phase2 = (await db.execute(
    correctNightSql(windowStart, windowEnd, input.hrIntervalMin, input.p75, input.p90, r),
  )) as Row[]
  if (!phase2.length)
    return { status: 'no_phase2_rows' }

  const rows: Phase2Row[] = phase2.map(p => ({
    date: String(p.date),
    quality: toNum(p.quality) ?? 0,
    start: String(p.start),
    unitLength: 1,
    source: String(p.source),
    confidence: toNum(p.confidence) ?? 0,
    session_id: toNum(p.session_id) ?? 0,
  }))

  const vitals: VitalSample[] = ((await db.execute(morningVitalsSql(windowStart, windowEnd, r))) as Row[])
    .map(v => ({ kind: String(v.kind), epoch: toNum(v.epoch) ?? 0, value: toNum(v.value) ?? Number.NaN }))

  return { status: 'ok', rows: classifyBlocks(rows, input.tzOffsetHours, vitals), vitals }
}

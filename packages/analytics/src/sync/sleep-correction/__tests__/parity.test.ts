/**
 * DuckDB port vs the v3.1 DataFusion pipeline, night by night.
 *
 * `fixtures/reference.v31.json` is the REAL v3.1 pipeline (ziva_app
 * `sleepCorrectionLayer.ts`, unchanged db0c58a43 → a611cecca) run through its
 * own `.sleep-harness/run_pipeline.js` on datafusion-cli 53.1.0, over every
 * study night. This suite runs the same captures through the DuckDB port with
 * the same conventions (capture timestamps are UTC; per-ring tz; baseline
 * cutoff = windowStart − 120 d) and compares.
 *
 * Two modes:
 *   - B (logic): the reference's own tier/p75/p90 are injected, so Phase 2 SQL
 *     and Phase 3 classify are compared with nothing else varying. Must match.
 *   - A (end to end): the port computes tier/p75/p90 itself. quantile_cont is
 *     exact where DataFusion approximated, so a night may move by a margin
 *     minute; each such night is reported with its scalar deltas.
 *
 * Captures are real users' ring data and are not in this repo. Set
 * SLEEP_CAPTURES_DIR to ziva_app `packages/ux/helpers/testFiles` to run.
 * SLEEP_PARITY_OUT=<file> writes the per-night comparison.
 */
import type { SqlRunner } from '../correct'

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../../__integration__/setup/real-engine'
import { computeNightEpochs } from '../classify'
import { correctNight, detectHrTier, globalBaselines } from '../correct'

const CAPTURES = process.env.SLEEP_CAPTURES_DIR
const OUT = process.env.SLEEP_PARITY_OUT
const REF = JSON.parse(readFileSync(join(__dirname, 'fixtures/reference.v31.json'), 'utf8')) as {
  nights: RefNight[]
}

interface RefNight {
  key: string
  ring: string
  iso: string
  tz: number
  capture?: string
  error?: string
  procStart?: number
  procEnd?: number
  tier?: number
  p75?: number
  p90?: number
  light?: number
  deep?: number
  rem?: number
  nPrimary?: number
  nRows?: number
}

interface PortNight {
  error?: string
  procStart?: number
  procEnd?: number
  light?: number
  deep?: number
  rem?: number
  nPrimary?: number
  nRows?: number
  tier?: number
  p75?: number
  p90?: number
}

/** Harness `epoch()`: "YYYY.MM.DD HH:MM:SS" parsed as UTC; numbers pass through. */
function epoch(v: unknown): number | null {
  if (v == null)
    return null
  if (typeof v === 'number')
    return Math.floor(v > 1e12 ? v / 1000 : v)
  const m = String(v).match(/(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/)
  if (!m) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : null
  }
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000)
}

const lit = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? 'NULL' : String(Number(v)))

async function insertChunks(db: SqlRunner, table: string, rows: unknown[][]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    const values = rows.slice(i, i + 1000).map(r => `(${r.map(lit).join(', ')})`).join(',\n')
    if (values)
      await db.execute(`INSERT INTO ${table} VALUES ${values}`)
  }
}

/** The capture, staged in the v3.1 raw shapes the harness gives DataFusion. */
async function stage(capture: Record<string, unknown[]>): Promise<SqlRunner & { close?: () => Promise<void> }> {
  const db = await createRealDuckDB([])
  await db.execute(`CREATE TABLE stg_sleep (date BIGINT, quality INT, start BIGINT, "unitLength" INT)`)
  await db.execute(`CREATE TABLE stg_heartrate (date BIGINT, "singleHR" DOUBLE)`)
  await db.execute(`CREATE TABLE stg_activity (date BIGINT, step DOUBLE)`)
  const rec = (x: unknown) => x as Record<string, unknown>
  await insertChunks(db, 'stg_sleep', (capture.sleep ?? []).map(rec).map(r => [epoch(r.date), r.quality, epoch(r.start), r.unitLength]))
  await insertChunks(db, 'stg_heartrate', (capture.heartrate ?? []).map(rec).map(r => [epoch(r.date), r.singleHR]))
  await insertChunks(db, 'stg_activity', (capture.activitydetails ?? []).map(rec).map(r => [epoch(r.date), r.step]))
  return db
}

async function runNight(
  db: SqlRunner,
  night: RefNight,
  scalars: { tier: number, p75: number, p90: number } | null,
): Promise<PortNight> {
  const { windowStart, windowEnd } = computeNightEpochs(night.iso, night.tz)
  let tier: number
  let p75: number
  let p90: number
  if (scalars) {
    ({ tier, p75, p90 } = scalars)
  }
  else {
    tier = await detectHrTier(db)
    ;({ p75, p90 } = await globalBaselines(db, windowStart - 120 * 86400))
  }
  const res = await correctNight(db, {
    windowStart,
    windowEnd,
    hrIntervalMin: tier,
    p75,
    p90,
    tzOffsetHours: night.tz,
  })
  if (res.status !== 'ok')
    return { error: res.status, tier, p75, p90 }
  const primary = res.rows.filter(r => r.block_type === 'primary')
  if (!primary.length)
    return { error: 'no_primary', tier, p75, p90 }
  const eps = primary.map(r => epoch(r.date)!).sort((a, b) => a - b)
  let light = 0
  let deep = 0
  let rem = 0
  for (const r of primary) {
    if (r.quality === 1)
      deep++
    else if (r.quality === 2)
      light++
    else if (r.quality === 3)
      rem++
  }
  return {
    procStart: eps[0],
    procEnd: eps[eps.length - 1],
    light,
    deep,
    rem,
    nPrimary: primary.length,
    nRows: res.rows.length,
    tier,
    p75,
    p90,
  }
}

interface Compared {
  key: string
  mode: 'A' | 'B'
  ok: boolean
  ref: RefNight
  port: PortNight
  dStartMin?: number
  dEndMin?: number
}

function compare(key: string, mode: 'A' | 'B', ref: RefNight, port: PortNight): Compared {
  if (ref.error || port.error)
    return { key, mode, ok: ref.error === port.error, ref, port }
  const dStartMin = (port.procStart! - ref.procStart!) / 60
  const dEndMin = (port.procEnd! - ref.procEnd!) / 60
  return { key, mode, ok: Math.abs(dStartMin) <= 2 && Math.abs(dEndMin) <= 2, ref, port, dStartMin, dEndMin }
}

describe.skipIf(!CAPTURES)('sleep correction — DuckDB port vs v3.1 DataFusion', () => {
  it('matches the reference night by night', async () => {
    const byCapture = new Map<string, RefNight[]>()
    for (const n of REF.nights) {
      if (!n.capture)
        continue
      byCapture.set(n.capture, [...(byCapture.get(n.capture) ?? []), n])
    }

    const results: Compared[] = []
    for (const [file, nights] of byCapture) {
      const capture = JSON.parse(readFileSync(join(CAPTURES!, file), 'utf8'))
      const db = await stage(capture)
      for (const ref of nights) {
        // Mode B needs the reference's scalars on EVERY night, error nights
        // included: without them a no_primary night silently ran end to end,
        // and exact-vs-approx p90 drift read as a logic divergence.
        const scalars = ref.tier != null && ref.p75 != null && ref.p90 != null
          ? { tier: ref.tier, p75: ref.p75, p90: ref.p90 }
          : null
        const b = await runNight(db, ref, scalars)
        results.push(compare(ref.key, 'B', ref, b))
        results.push(compare(ref.key, 'A', ref, await runNight(db, ref, null)))
      }
      await db.close?.()
    }

    if (OUT)
      writeFileSync(OUT, JSON.stringify(results, null, 1))

    const failedB = results.filter(r => r.mode === 'B' && !r.ok).map(r => r.key)
    const failedA = results.filter(r => r.mode === 'A' && !r.ok)
    console.log(`parity B (logic): ${results.filter(r => r.mode === 'B' && r.ok).length}/${results.filter(r => r.mode === 'B').length}`
      + `   parity A (end to end): ${results.filter(r => r.mode === 'A' && r.ok).length}/${results.filter(r => r.mode === 'A').length}`)
    for (const r of failedA) {
      console.log(`  A drift ${r.key}: start ${r.dStartMin} end ${r.dEndMin} | tier ${r.ref.tier}->${r.port.tier} `
        + `p75 ${r.ref.p75}->${r.port.p75} p90 ${r.ref.p90}->${r.port.p90} ${r.port.error ?? ''}`)
    }
    expect(failedB).toEqual([])
  }, 600_000)
})

/**
 * Sleep correction — Phase 3 and the night window (sleep-correction port).
 *
 * VERBATIM port of ziva_app `packages/ux/helpers/sleepCorrectionLayer.ts` v3.1
 * (`fix/sleepProcessed`, unchanged db0c58a43 → a611cecca): `computeNightEpochs`,
 * `parseDateStr`, `classifyBlocks` and every constant. Only the formatting
 * follows this repo's lint; the logic, order of operations and constants are
 * the validated ones (END within-30 74% → 88% on the QA study set) and must
 * not be retuned during the port. The parity harness is the check.
 *
 * Timestamps are epoch seconds. Row `date`/`start` strings are the Phase 2
 * output shape, "YYYY.MM.DD HH:MM:SS" in UTC.
 */

export const HR_MIN = 40
export const HR_MAX = 120
export const EXTEND_AFTER = 7200 // max seconds to extend past firmware end
export const LONG_GAP_MIN = 600
export const LONG_GAP_MAX = 28800
export const LONG_GAP_HR_FRAC = 0.40
export const STITCH_GAP_SHORT = 120
export const STITCH_GAP_MED = 300
export const STITCH_GAP_LONG = 1200
export const BLOCK_SEP = 1800
export const BOUT_MAX_LEN = 1
// Morning over-extension guard (Step 5.5): only trim when the primary END lands
// in this late-morning band.
export const MORNING_TRIM_FLOOR_MIN = 7 * 60 // 07:00 local
export const MORNING_TRIM_CEIL_MIN = 14 * 60 // 14:00 local
export const FETCH_BEFORE = 21600 // 6h before window, so envelope HR context spans pre-sleep
export const FETCH_AFTER = 1800
export const CONF_FIRMWARE = 0.90
export const CONF_ENVELOPE = 0.50
export const CONF_GAP = 0.40
export const CONF_BOUT = 0.70

// HR + movement END refinement (Step 5.6).
export const END_BASE_PCTILE = 0.20 // personal sleep-HR baseline = 20th pct of in-block HR
export const END_WAKE_MARGIN_BPM = 12 // wake threshold = baseline + max(this, frac*baseline)
export const END_WAKE_MARGIN_FRAC = 0.18
export const END_QUIET_STEPS = 80 // steps within ±10min for a sample to still count "asleep"
export const END_WAKE_STEPS = 150 // steps after the cut required to confirm wake (movement)
export const END_MIN_TRIM = 1800 // 30min — only correct clear over-extensions
export const END_MIN_SLEEP = 7200 // 2h — never collapse the primary block below this
export const END_WAKE_SUSTAIN = 1200 // 20min — the awake run after the cut must persist
export const END_GAP_TOL = 900 // 15min — tolerance for step/HR sample proximity

/**
 * 'YYYY-MM-DD' night → epoch window [18:00 previous local day, 18:00 local).
 *
 * `tzOffsetHours` is the offset in force for THIS night. v3.1 fed it one fixed
 * device offset; the port's caller derives it per night from the user's IANA
 * zone (spec: per-night IANA offset), so DST nights land correctly.
 */
export function computeNightEpochs(
  nightDate: string,
  tzOffsetHours: number = 0,
): { windowStart: number, windowEnd: number } {
  const [year, month, day] = nightDate.split('-').map(Number)
  const nightMidnightUtc = Date.UTC(year, month - 1, day) / 1000
  const priorMidnightUtc = nightMidnightUtc - 86400
  const tzOffsetSec = Math.round(tzOffsetHours * 3600)
  return {
    windowStart: priorMidnightUtc + 18 * 3600 - tzOffsetSec,
    windowEnd: nightMidnightUtc + 18 * 3600 - tzOffsetSec,
  }
}

const DOT_RE = /\./g

/** "YYYY.MM.DD HH:mm:ss" (UTC) → epoch seconds. v3.1 verbatim. */
export function parseDateStr(d: string): number {
  if (!d)
    return 0
  // "2026.04.18 16:52:01" → "2026-04-18T16:52:01Z"
  const iso = `${d.replace(DOT_RE, (_m, offset) => offset < 10 ? '-' : '.').replace(' ', 'T')}Z`
  return Math.floor(new Date(iso).getTime() / 1000)
}

/** A Phase 2 output row. */
export interface Phase2Row {
  date: string
  quality: number
  start: string
  unitLength: number
  source: string
  confidence: number
  session_id: number
}

/** A Phase 3 output row — v3.1's `sleep_processed` row shape. */
export interface ClassifiedRow {
  date: string
  quality: number
  start: string
  unitLength: number
  source: string
  confidence: number
  block_type: string
}

export interface VitalSample {
  kind: string
  epoch: number
  value: number
}

/**
 * Bout consolidation + block classification (primary / secondary /
 * microsleep), the synthetic head/tail trims and the Step 5.6 HR + movement
 * END refinement. v3.1 verbatim — see the file header.
 */
export function classifyBlocks(
  rows: Phase2Row[],
  tzOffsetHours: number = 0,
  vitals?: VitalSample[],
): ClassifiedRow[] {
  if (!rows || rows.length === 0)
    return []
  const tzOffsetSec = Math.round(tzOffsetHours * 3600)
  const localHour = (epoch: number) => new Date((epoch + tzOffsetSec) * 1000).getUTCHours()

  // Step 1: Assign bout IDs (consecutive same-quality runs)
  const withBouts = rows.map((row, i) => {
    const prev = rows[i - 1]
    const isBoutStart = !prev
      || row.quality !== prev.quality
      || parseDateStr(row.date) - parseDateStr(prev.date) > 65
      || row.quality === 5
      || (prev && prev.quality === 5)
    return { ...row, is_bout_start: isBoutStart ? 1 : 0 }
  })

  let boutId = 0
  const withBoutIds = withBouts.map((row) => {
    if (row.is_bout_start)
      boutId++
    return { ...row, bout_id: boutId }
  })

  // Step 2: Consolidate short deep bouts → light (never REM)
  const boutLengths: Record<number, number> = {}
  const boutQualities: Record<number, number> = {}
  for (const row of withBoutIds) {
    boutLengths[row.bout_id] = (boutLengths[row.bout_id] || 0) + 1
    boutQualities[row.bout_id] = row.quality
  }

  const consolidated = withBoutIds.map((row) => {
    const len = boutLengths[row.bout_id]
    const qual = boutQualities[row.bout_id]
    const prevBoutQual = boutQualities[row.bout_id - 1]
    const nextBoutQual = boutQualities[row.bout_id + 1]
    // Only consolidate deep sleep (1) micro-fragments — never REM (3).
    const isMergeable = qual === 1
      && len <= BOUT_MAX_LEN
      && (prevBoutQual === 2 || nextBoutQual === 2)

    return {
      ...row,
      quality: isMergeable ? 2 : row.quality,
      source: isMergeable ? 'bout_consolidated' : row.source,
      confidence: isMergeable ? CONF_BOUT : row.confidence,
    }
  })

  // Step 3: Assign block IDs (gaps > BLOCK_SEP = new block)
  let blockId = 0
  const withBlocks = consolidated.map((row, i) => {
    const prev = consolidated[i - 1]
    if (!prev || parseDateStr(row.date) - parseDateStr(prev.date) > BLOCK_SEP)
      blockId++
    return { ...row, block_id: blockId }
  })

  // Step 4: Find primary block (most sleep minutes during NIGHT hours)
  const blockSleepMins: Record<number, number> = {}
  const blockNightMins: Record<number, number> = {}
  const blockFwMins: Record<number, number> = {}
  const sessionSizes: Record<number, number> = {}
  const sessionFwMins: Record<number, number> = {}

  for (const row of withBlocks) {
    if ([1, 2, 3].includes(row.quality)) {
      blockSleepMins[row.block_id] = (blockSleepMins[row.block_id] || 0) + 1
      // Core-night window (20:00–10:00 local) only, so a spurious daytime
      // firmware block can't be picked as the primary sleep.
      const h = localHour(parseDateStr(row.date))
      if (h >= 20 || h < 10)
        blockNightMins[row.block_id] = (blockNightMins[row.block_id] || 0) + 1
    }
    if (row.source === 'firmware') {
      blockFwMins[row.block_id] = (blockFwMins[row.block_id] || 0) + 1
      sessionFwMins[row.session_id] = (sessionFwMins[row.session_id] || 0) + 1
    }
    sessionSizes[row.session_id] = (sessionSizes[row.session_id] || 0) + 1
  }

  // Prefer the block with the most night-hour sleep; fall back to total sleep
  // minutes when no block has any (e.g. shift workers).
  const primaryScore = Object.keys(blockNightMins).length ? blockNightMins : blockSleepMins
  const primaryBlockId = Object.entries(primaryScore)
    .sort(([idA, a], [idB, b]) => b - a || Number(idA) - Number(idB))[0]?.[0]

  const isFwBacked = (s: string) => s === 'firmware' || s === 'bout_consolidated'
  const primaryIndices = (): number[] => {
    const primIdx: number[] = []
    withBlocks.forEach((row, i) => {
      if (String(row.block_id) === primaryBlockId)
        primIdx.push(i)
    })
    return primIdx
  }

  // Step 5.5: Trailing-synthetic-tail trim (morning over-extension guard).
  const trimmedIdx = new Set<number>()
  if (primaryBlockId != null && (blockFwMins[Number(primaryBlockId)] || 0) > 0) {
    const primIdx = primaryIndices()
    const lastIdx = primIdx[primIdx.length - 1]
    const endLocalMin = ((((parseDateStr(withBlocks[lastIdx].date) + tzOffsetSec) % 86400) + 86400) % 86400) / 60
    if (endLocalMin >= MORNING_TRIM_FLOOR_MIN && endLocalMin < MORNING_TRIM_CEIL_MIN) {
      for (let p = primIdx.length - 1; p >= 0; p--) {
        if (isFwBacked(withBlocks[primIdx[p]].source))
          break
        trimmedIdx.add(primIdx[p])
      }
    }
  }

  // Step 5.5b: Leading-synthetic-head trim (evening onset guard).
  if (primaryBlockId != null && (blockFwMins[Number(primaryBlockId)] || 0) > 0) {
    const primIdx = primaryIndices()
    for (let p = 0; p < primIdx.length; p++) {
      if (isFwBacked(withBlocks[primIdx[p]].source))
        break
      trimmedIdx.add(primIdx[p])
    }
  }

  // Step 5.6: HR + movement END refinement.
  if (vitals && vitals.length && primaryBlockId != null) {
    const hr = vitals
      .filter(v => v.kind === 'hr' && Number.isFinite(v.value) && v.value > 0)
      .map(v => ({ e: Number(v.epoch), v: Number(v.value) }))
      .sort((a, b) => a.e - b.e)
    const steps = vitals
      .filter(v => v.kind === 'step' && Number.isFinite(v.value))
      .map(v => ({ e: Number(v.epoch), v: Number(v.value) }))
      .sort((a, b) => a.e - b.e)
    const stepsIn = (a: number, b: number) => {
      let s = 0
      for (const x of steps) {
        if (x.e > a && x.e <= b)
          s += x.v
      }
      return s
    }

    const primIdx = primaryIndices()
    const procStart = parseDateStr(withBlocks[primIdx[0]].date)
    const procEnd = parseDateStr(withBlocks[primIdx[primIdx.length - 1]].date)

    const inBlock = hr.filter(h => h.e >= procStart && h.e <= procEnd).map(h => h.v).sort((a, b) => a - b)
    if (inBlock.length >= 4) {
      const base = inBlock[Math.min(inBlock.length - 1, Math.floor(END_BASE_PCTILE * inBlock.length))]
      const thr = base + Math.max(END_WAKE_MARGIN_BPM, END_WAKE_MARGIN_FRAC * base)
      // "Asleep" only if HR is at sleep level AND steps are quiet around it.
      const asleepAt = (h: { e: number, v: number }) =>
        h.v <= thr && stepsIn(h.e - END_GAP_TOL + 300, h.e + END_GAP_TOL - 300) <= END_QUIET_STEPS

      const tail = hr.filter(h => h.e >= procStart && h.e <= procEnd + END_GAP_TOL)
      let wakeAt = procEnd
      for (let i = tail.length - 1; i >= 0; i--) {
        if (asleepAt(tail[i])) {
          wakeAt = tail[i].e
          break
        }
      }

      const runLen = procEnd - wakeAt
      const stepsAfter = stepsIn(wakeAt, procEnd + END_GAP_TOL)
      if (wakeAt < procEnd
        && runLen >= END_WAKE_SUSTAIN
        && stepsAfter >= END_WAKE_STEPS
        && runLen >= END_MIN_TRIM
        && (wakeAt - procStart) >= END_MIN_SLEEP) {
        for (const i of primIdx) {
          if (parseDateStr(withBlocks[i].date) > wakeAt)
            trimmedIdx.add(i)
        }
      }
    }
  }

  // Step 5: Assign block_type
  return withBlocks.map(({ is_bout_start: _b, bout_id: _bo, block_id, session_id, ...row }, i) => ({
    ...row,
    block_type:
      sessionSizes[session_id] < 30 && !sessionFwMins[session_id]
        ? 'microsleep'
        : (blockFwMins[block_id] || 0) === 0 && (blockSleepMins[block_id] || 0) < 30
            ? 'microsleep'
            : String(block_id) === primaryBlockId
              ? (trimmedIdx.has(i) ? 'secondary' : 'primary')
              : 'secondary',
  }))
}

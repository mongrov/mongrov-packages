#!/usr/bin/env node
/**
 * Sleep display parity, step 2 of 3: what ziva_app v1 (v3.1) would SHOW for
 * every night of every dump, computed by v1's own code.
 *
 * Nothing here re-implements v1. The correction layer
 * (`sleepCorrectionLayer.ts`) and the two screen queries the Sleep Day tab
 * reads (`sleepSummaryQuery`, `aggregateValuesQuery` in `sqlquery.ts`) are
 * read out of ziva_app's git at `V1_REF`, with only their alias imports
 * stubbed, and run on datafusion-cli, the engine v1 shipped on. What this
 * script adds is v1's production loop around them
 * (`AppContextProvider.tsx` post-sync correction): every calendar night from
 * the first to one past the last, in order, `correctNightQuery` →
 * `computeMorningVitalsQuery` → `classifyBlocks` → `clearNightQuery` +
 * insert into `sleep_processed`. Then, per night, the Day tab's reads
 * (`RingManager.sleepSummaryData` / `sleepOverviewData`) over that table, in
 * the window `getStartAndEndOfDayUnix(date, true)` gives.
 *
 * Two variants per night:
 *   - `v1`: v1 as it ran (whole-history HR tier, DataFusion's approximate
 *     percentiles).
 *   - `v1AtV2Scalars`: the same code fed the scalars v2 computed (per-night
 *     tier — ruling D3 — and exact percentiles), read from the export's
 *     `meta.json`. v2 vs this variant is the drift the rulings do not explain.
 *
 * Inputs (env):
 *   SLEEP_CAPTURES_DIR       ziva_app packages/ux/helpers/testFiles
 *   SLEEP_REPLAY_EXPORT_DIR  output of step 1 (replay-v1.test.ts); this
 *                            script writes `<dump>/v1-display.json` beside it
 *   ZIVA_APP_DIR             a ziva_app checkout (read with `git show` only)
 *   V1_REF                   default `fix/sleepProcessed`
 *   DATAFUSION_CLI           default `/opt/homebrew/bin/datafusion-cli`
 *   JOBS                     parallel dumps, default 6
 *   ONLY                     optional substring filter on dump names
 *   WITH_ROWS                set to also write the emulated sleep_processed rows (debugging)
 *
 * Conventions shared with step 1, so the two sides differ only by code:
 * dump timestamps are UTC; the zone is `meta.json`'s; the baseline cutoff is
 * `meta.cutoffEpoch` (last raw sleep minute + 60 s − lookback days).
 */
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)

const STAMP_RE = /(\d{4})\.(\d{2})\.(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/
const CSV_SPECIAL_RE = /[",\n]/
const QUOTE_RE = /"/g
const TRAILING_SEMI_RE = /;\s*$/
const NEWLINE_RE = /\r?\n/
const CSV_EXT_RE = /\.csv$/

const CAPTURES = need('SLEEP_CAPTURES_DIR')
const EXPORT = need('SLEEP_REPLAY_EXPORT_DIR')
const ZIVA = need('ZIVA_APP_DIR')
const REF = process.env.V1_REF ?? 'fix/sleepProcessed'
const CLI = process.env.DATAFUSION_CLI ?? '/opt/homebrew/bin/datafusion-cli'
const JOBS = Number(process.env.JOBS ?? 6)
const ONLY = process.env.ONLY ?? ''

function need(name) {
  const v = process.env[name]
  if (!v) {
    console.error(`${name} is required (see the header of ${import.meta.url})`)
    process.exit(2)
  }
  return v
}

// ---------------------------------------------------------------------------
// v1's code, out of git
// ---------------------------------------------------------------------------

const work = mkdtempSync(join(tmpdir(), 'sleep-v1-oracle-'))
const show = path => execFileSync('git', ['-C', ZIVA, 'show', `${REF}:${path}`], { encoding: 'utf8', maxBuffer: 64 << 20 })
const v1Sha = execFileSync('git', ['-C', ZIVA, 'rev-parse', '--short', REF], { encoding: 'utf8' }).trim()

// The correction layer: the same two-line stub `.sleep-harness/sleepcore.ts` uses.
const coreSrc = show('packages/ux/helpers/sleepCorrectionLayer.ts')
  .replace(/^import \{ guessUsersTimeZone \} from "\.\/date";$/m, 'const guessUsersTimeZone = () => "UTC";')
  .replace(/^import \{ currentDataViewUser \} from "@falconz\/application\/context";$/m, 'const currentDataViewUser = () => ({});')
if (/^import /m.test(coreSrc))
  throw new Error('sleepCorrectionLayer.ts gained an import this script does not stub')
writeFileSync(join(work, 'core.ts'), coreSrc)

// The Day tab's two queries, cut verbatim out of sqlquery.ts. `getTimezone()`
// is the viewed user's zone in v1; here it is the dump's.
const sqlSrc = show('packages/ux/helpers/sqlquery.ts')
function cut(name) {
  const at = sqlSrc.indexOf(`export const ${name} = `)
  if (at < 0)
    throw new Error(`sqlquery.ts has no ${name}`)
  const next = sqlSrc.indexOf('\nexport const ', at + 1)
  return sqlSrc.slice(at, next < 0 ? undefined : next)
}
writeFileSync(join(work, 'screen.ts'), [
  'let zone = "UTC";',
  'export const setZone = (z: string) => { zone = z; };',
  'const getTimezone = () => zone;',
  'const TEMPERATURE_TABLE = "temperature_table";',
  cut('sleepSummaryQuery'),
  cut('aggregateValuesQuery'),
].join('\n'))

const core = await import(pathToFileURL(join(work, 'core.ts')).href)
const screen = await import(pathToFileURL(join(work, 'screen.ts')).href)

// ---------------------------------------------------------------------------
// datafusion-cli plumbing (as `.sleep-harness/run_pipeline.js`)
// ---------------------------------------------------------------------------

/** "YYYY.MM.DD HH:MM:SS" parsed as UTC → epoch s; numbers pass through. */
function epoch(v) {
  if (v == null)
    return null
  if (typeof v === 'number')
    return Math.floor(v > 1e12 ? v / 1000 : v)
  const m = String(v).match(STAMP_RE)
  if (!m) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.floor(n) : null
  }
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000)
}

function csvField(v) {
  if (v == null)
    return ''
  const s = String(v)
  return CSV_SPECIAL_RE.test(s) ? `"${s.replace(QUOTE_RE, '""')}"` : s
}

/** v1's tables, the columns v1's SQL reads, in v1's names. */
const TABLES = {
  heartrate: { cols: 'date BIGINT, "singleHR" DOUBLE', header: ['date', 'singleHR'], map: r => [epoch(r.date), r.singleHR] },
  hrv_table: { cols: 'date BIGINT, "heartRate" DOUBLE, hrv DOUBLE', header: ['date', 'heartRate', 'hrv'], map: r => [epoch(r.date), r.heartRate, r.hrv] },
  spo2: { cols: 'date BIGINT, "automaticSpo2Data" DOUBLE', header: ['date', 'automaticSpo2Data'], map: r => [epoch(r.date), r.automaticSpo2Data] },
  activitydetails: { cols: 'date BIGINT, step DOUBLE', header: ['date', 'step'], map: r => [epoch(r.date), r.step] },
  sleep: { cols: 'date BIGINT, quality INT, start BIGINT, "unitLength" INT', header: ['date', 'quality', 'start', 'unitLength'], map: r => [epoch(r.date), r.quality, epoch(r.start), r.unitLength] },
}

function writeCsv(file, header, rows) {
  writeFileSync(file, `${[header.join(','), ...rows.map(r => r.map(csvField).join(','))].join('\n')}\n`)
}

function rawDdl(dump, dir) {
  const ddl = []
  for (const [name, spec] of Object.entries(TABLES)) {
    const rows = Array.isArray(dump[name]) ? dump[name] : []
    const file = join(dir, `${name}.csv`)
    writeCsv(file, spec.header, rows.map(spec.map))
    ddl.push(`CREATE EXTERNAL TABLE ${name} (${spec.cols}) STORED AS CSV LOCATION '${file}' OPTIONS ('has_header' 'true');`)
  }
  return ddl.join('\n')
}

/**
 * Every statement's result is COPYed to its own file, tagged. Not read off
 * stdout: datafusion-cli 53's `--format csv` printer drops rows from results
 * that arrive in several batches (its "N row(s) fetched" stays right), so a
 * large Phase 2 or vitals read came back short, differently each run.
 */
const tagged = (tag, sql) => `COPY (SELECT '${tag}' AS __tag, * FROM (${sql.trim().replace(TRAILING_SEMI_RE, '')}) q) TO '__OUT__/${tag}.csv' STORED AS CSV OPTIONS ('format.has_header' 'true');`

function splitCsv(line) {
  const out = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"'
          i++
        }
        else { q = false }
      }
      else { cur += ch }
    }
    else if (ch === '"') {
      q = true
    }
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    }
    else { cur += ch }
  }
  out.push(cur)
  return out
}

/** Run one SQL file; rows grouped by `__tag`. */
async function runSql(dir, name, sql) {
  const outDir = join(dir, `out-${name}`)
  mkdirSync(outDir, { recursive: true })
  const file = join(dir, `${name}.sql`)
  // One partition: v3.1's window functions order by `date` alone, and with
  // several partitions DataFusion may break their ties differently run to
  // run (the class of tie v2 fixed in packages#52).
  writeFileSync(file, `SET datafusion.execution.target_partitions = 1;\n${sql.replaceAll('__OUT__', outDir)}`)
  await run(CLI, ['-f', file], { maxBuffer: 64 << 20 })
  const byTag = new Map()
  for (const f of readdirSync(outDir)) {
    const lines = readFileSync(join(outDir, f), 'utf8').split(NEWLINE_RE).filter(l => l !== '')
    if (!lines.length)
      continue
    const cols = splitCsv(lines[0])
    const rows = lines.slice(1).map((line) => {
      const vals = splitCsv(line)
      const o = {}
      cols.forEach((c, i) => (o[c] = vals[i]))
      return o
    })
    byTag.set(f.replace(CSV_EXT_RE, ''), rows)
  }
  return byTag
}

const num = v => (v == null || v === '' ? null : Number(v))

// ---------------------------------------------------------------------------
// v1's dates and windows
// ---------------------------------------------------------------------------

/** `getOffsetMs` from ziva_app `date.ts`, verbatim in effect. */
function offsetMs(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, Number.parseInt(p.value, 10)]))
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - date.getTime()
}

/** `getStartAndEndOfDayUnix(date, true)`: [D-1 18:00:00, D 17:59:59] local. */
function dayTabWindow(iso, zone) {
  const [y, m, d] = iso.split('-').map(Number)
  const s = new Date(Date.UTC(y, m - 1, d - 1, 18, 0, 0))
  const e = new Date(Date.UTC(y, m - 1, d, 17, 59, 59))
  return { start: Math.floor((s.getTime() - offsetMs(s, zone)) / 1000), end: Math.floor((e.getTime() - offsetMs(e, zone)) / 1000) }
}

/** The tz offset (h) in force at the night's 18:00 — what v1's `getTzOffsetHours()` returns on a phone in that zone then. */
function offsetHoursAt(iso, zone) {
  const [y, m, d] = iso.split('-').map(Number)
  return offsetMs(new Date(Date.UTC(y, m - 1, d - 1, 12, 30)), zone) / 3_600_000
}

function shiftIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// One dump
// ---------------------------------------------------------------------------

async function oneDump(name) {
  const meta = JSON.parse(readFileSync(join(EXPORT, name, 'meta.json'), 'utf8'))
  const dump = JSON.parse(readFileSync(join(CAPTURES, meta.dump), 'utf8'))
  const zone = meta.zone
  const dir = mkdtempSync(join(work, `${name}-`))
  try {
    const ddl = rawDdl(dump, dir)
    // v1's loop: every calendar night from the first new chunk to "today".
    // `meta.nights` are the nights holding firmware sleep; one more is
    // processed after the last, as a later sync would, so its clearNight
    // runs over the last night's tail exactly as on a phone.
    if (!meta.nights.length)
      return { name, nights: {} }
    const dates = []
    for (let iso = meta.nights[0]; iso <= shiftIso(meta.nights.at(-1), 1); iso = shiftIso(iso, 1)) dates.push(iso)
    const win = Object.fromEntries(dates.map(iso => [iso, { ...core.computeNightEpochs(iso, offsetHoursAt(iso, zone)), tz: offsetHoursAt(iso, zone) }]))

    // Once per sync, as AppContextProvider does.
    const pre = await runSql(dir, 'pre', [ddl, tagged('tier', core.detectHrTierQuery()), tagged('base', core.computeGlobalBaselinesQuery(meta.cutoffEpoch))].join('\n'))
    const v1Tier = num(pre.get('tier')?.[0]?.hr_interval_minutes) ?? 5
    const v1P90 = num(pre.get('base')?.[0]?.p90_global) ?? 120
    const v1P75 = num(pre.get('base')?.[0]?.p75_global) ?? 80

    // Morning vitals do not depend on the scalars.
    const pv = await runSql(dir, 'pv', [ddl, ...dates.map((iso, i) => tagged(`v${i}`, core.computeMorningVitalsQuery(win[iso].windowStart, win[iso].windowEnd)))].join('\n'))
    const vitalsOf = i => (pv.get(`v${i}`) ?? []).map(r => ({ kind: r.kind, epoch: Number(r.epoch), value: Number(r.value) })).sort((a, b) => a.epoch - b.epoch)

    const variants = {
      v1: () => ({ tier: v1Tier, p75: v1P75, p90: v1P90 }),
      v1AtV2Scalars: iso => ({ tier: meta.tiers[iso]?.tier ?? v1Tier, p75: meta.p75, p90: meta.p90 }),
    }
    const out = { name, zone, v1Sha, scalars: { v1: { tier: v1Tier, p75: v1P75, p90: v1P90 } }, variants: {} }
    for (const [variant, scalarsFor] of Object.entries(variants)) {
      const p2 = await runSql(dir, `p2-${variant}`, [ddl, ...dates.map((iso, i) => {
        const s = scalarsFor(iso)
        return tagged(`n${i}`, core.correctNightQuery(win[iso].windowStart, win[iso].windowEnd, s.tier, s.p75, s.p90))
      })].join('\n'))

      // sleep_processed, as clearNight + insert leave it. `date` is unique in
      // v1's schema, so a re-insert of a minute replaces it.
      const table = new Map()
      dates.forEach((iso, i) => {
        const rows = (p2.get(`n${i}`) ?? [])
          .map(r => ({ date: r.date, quality: Number(r.quality), start: r.start, unitLength: 1, source: r.source, confidence: Number(r.confidence), session_id: Number(r.session_id) }))
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
        if (!rows.length)
          return // v1: "No corrected rows — skipping insert" (and no clear)
        const final = core.classifyBlocks(rows, win[iso].tz, vitalsOf(i))
        for (const e of [...table.keys()]) {
          if (e >= win[iso].windowStart && e < win[iso].windowEnd)
            table.delete(e)
        }
        for (const r of final) table.set(epoch(r.date), r)
      })
      const spFile = join(dir, `sleep_processed-${variant}.csv`)
      writeCsv(spFile, ['date', 'quality', 'start', 'unitLength', 'source', 'confidence', 'block_type'], [...table.entries()].sort((a, b) => a[0] - b[0]).map(([e, r]) => [e, r.quality, r.start, r.unitLength, r.source, r.confidence, r.block_type]))
      const spDdl = `CREATE EXTERNAL TABLE sleep_processed (date BIGINT, quality INT, start VARCHAR, "unitLength" INT, source VARCHAR, confidence DOUBLE, block_type VARCHAR) STORED AS CSV LOCATION '${spFile}' OPTIONS ('has_header' 'true');`

      // The Day tab: summary, then the overview vitals over [start_utc, end_utc].
      screen.setZone(zone)
      const days = dates.map(iso => ({ iso, ...dayTabWindow(iso, zone) }))
      const sum = await runSql(dir, `sum-${variant}`, [ddl, spDdl, ...days.map((d, i) => tagged(`s${i}`, screen.sleepSummaryQuery('sleep_processed', d.start, d.end)))].join('\n'))
      const shown = days.map((d, i) => ({ ...d, s: sum.get(`s${i}`)?.[0] })).filter(d => num(d.s?.total) > 0)
      const ov = await runSql(dir, `ov-${variant}`, [ddl, ...shown.flatMap((d, i) => [
        tagged(`hr${i}`, screen.aggregateValuesQuery('heartrate', 'singleHR', num(d.s.start_utc), num(d.s.end_utc), 0)),
        tagged(`o2${i}`, screen.aggregateValuesQuery('spo2', 'automaticSpo2Data', num(d.s.start_utc), num(d.s.end_utc), 0)),
        tagged(`hv${i}`, screen.aggregateValuesQuery('hrv_table', 'hrv', num(d.s.start_utc), num(d.s.end_utc), 0)),
      ])].join('\n'))
      const nights = {}
      shown.forEach((d, i) => {
        const total = num(d.s.total)
        const awake = num(d.s.awake)
        const metric = tag => ({ average: num(ov.get(tag)?.[0]?.average), maximum: num(ov.get(tag)?.[0]?.maximum) })
        nights[d.iso] = {
          // SleepDayTab.tsx: chart headline `total`, "Total Sleep Time" total − awake
          total,
          asleep: total - awake,
          deep: num(d.s.deep),
          light: num(d.s.light),
          rem: num(d.s.rem),
          awake,
          // bedtime / wake-up: MIN(date) / MAX(date), local
          start: d.s.start,
          end: d.s.end,
          startUtc: num(d.s.start_utc),
          endUtc: num(d.s.end_utc),
          // SleepDayTab.tsx sleepEfficiency
          efficiency: Number((((total - awake) / (total || 1)) * 100).toFixed(0)),
          // SleepOverview: Avg Heart Rate / Avg SpO2 / Avg HRV (value = average, total = maximum)
          hr: metric(`hr${i}`),
          spo2: metric(`o2${i}`),
          hrv: metric(`hv${i}`),
        }
      })
      out.variants[variant] = nights
      if (process.env.WITH_ROWS)
        out[`rows_${variant}`] = [...table.entries()].sort((a, b) => a[0] - b[0]).map(([e, r]) => [e, r.quality, r.block_type, r.source])
    }
    return out
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

const names = readdirSync(EXPORT, { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(EXPORT, d.name, 'meta.json')) && d.name.includes(ONLY))
  .map(d => d.name)
  .sort()
let done = 0
let nightsTotal = 0
const queue = [...names]
async function worker() {
  for (let name = queue.shift(); name; name = queue.shift()) {
    const res = await oneDump(name)
    mkdirSync(join(EXPORT, name), { recursive: true })
    writeFileSync(join(EXPORT, name, 'v1-display.json'), JSON.stringify({ generatedAt: new Date().toISOString(), v1Ref: REF, ...res }, null, 1))
    nightsTotal += Object.keys(res.variants?.v1 ?? {}).length
    done++
    if (done % 10 === 0 || done === names.length)
      console.log(`v1 display oracle: ${done}/${names.length} dumps, ${nightsTotal} nights`)
  }
}
try {
  await Promise.all(Array.from({ length: Math.min(JOBS, names.length) }, worker))
}
finally {
  rmSync(work, { recursive: true, force: true })
}
console.log(`v1 display oracle (${REF} @ ${v1Sha}, datafusion-cli): ${names.length} dumps, ${nightsTotal} nights → ${EXPORT}/<dump>/v1-display.json`)

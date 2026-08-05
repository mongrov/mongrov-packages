/**
 * Per-query latency instrumentation (Sprint 5 T-45 / item (b)).
 *
 * Exists to answer one question with data instead of opinion: **is the
 * `v_{table}` watermark subquery actually expensive?**
 *
 * Every union view resolves the push watermark through a correlated
 * subquery on each scan. That is presumed cheap — a primary-key lookup on a
 * table with one row per (tenant, table, kind) — but the analytics package
 * ships a watermark cache behind a measurement gate precisely because
 * "presumed" is not "measured", and caching a value that gates data
 * visibility trades a millisecond for a correctness risk.
 *
 * The gate is `p95 > 20ms` for hot registry queries (principles §Open
 * Items). This module produces that number.
 *
 * ## Design notes
 *
 * - **Rolling window, not cumulative.** A 24h window matches the pilot
 *   reporting cadence and stops a slow cold-start from permanently
 *   poisoning p95 the way an all-time average would.
 * - **Bounded memory.** Samples are capped per query name; the oldest are
 *   evicted. An unbounded array on a long-lived mobile process is a leak.
 * - **Records failures separately.** A query that throws after 3s still
 *   consumed 3s, but mixing it into the success distribution would make a
 *   timeout look like a slow read. Both are counted; only successes shape
 *   the percentiles.
 * - **Off by default.** Instrumentation on the hot path should be opt-in.
 */

/** Default rolling window. Matches the pilot's reporting cadence. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Per-name sample cap. ~24h of a 30s-staleTime query with headroom. */
export const DEFAULT_MAX_SAMPLES = 2_000

/** The gate from principles §Open Items — cache only if p95 exceeds this. */
export const WATERMARK_CACHE_GATE_MS = 20

const WATERMARK_CACHE_GATE_LABEL = `${WATERMARK_CACHE_GATE_MS}ms p95`

export interface QueryLatencyStats {
  queryName: string
  count: number
  errorCount: number
  p50: number
  p95: number
  p99: number
  min: number
  max: number
  mean: number
  /** True when p95 crosses the watermark-cache activation gate. */
  exceedsGate: boolean
}

export interface InstrumentationReport {
  windowMs: number
  generatedAt: string
  queries: QueryLatencyStats[]
  /** Query names whose p95 crossed the gate, worst first. */
  overGate: string[]
}

export interface QueryInstrumentationConfig {
  enabled?: boolean
  windowMs?: number
  maxSamples?: number
  /** Injectable clock so tests need no timers. */
  now?: () => number
}

interface Sample {
  at: number
  ms: number
}

export interface QueryInstrumentation {
  readonly enabled: boolean
  /** Record one completed execution. */
  record(queryName: string, durationMs: number, ok: boolean): void
  /** Time a thunk, recording success or failure. Rethrows. */
  measure<T>(queryName: string, run: () => Promise<T>): Promise<T>
  /** Stats for one query, or null if it has no samples in-window. */
  statsFor(queryName: string): QueryLatencyStats | null
  /** Full report, worst p95 first. */
  report(): InstrumentationReport
  reset(): void
}

/** Nearest-rank percentile over a sorted array. 0 for an empty sample. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]
}

export function createQueryInstrumentation(
  config: QueryInstrumentationConfig = {}
): QueryInstrumentation {
  const enabled = config.enabled ?? false
  const windowMs = config.windowMs ?? DEFAULT_WINDOW_MS
  const maxSamples = config.maxSamples ?? DEFAULT_MAX_SAMPLES
  const now = config.now ?? (() => Date.now())

  const samples = new Map<string, Sample[]>()
  const errors = new Map<string, number>()

  /** Drop samples older than the window, in place. */
  function prune(list: Sample[]): Sample[] {
    const cutoff = now() - windowMs
    let i = 0
    while (i < list.length && list[i].at < cutoff) i += 1
    if (i > 0) list.splice(0, i)
    return list
  }

  function buildStats(name: string, list: Sample[]): QueryLatencyStats | null {
    if (list.length === 0) return null
    const durations = list.map((s) => s.ms).sort((a, b) => a - b)
    const p95 = percentile(durations, 95)
    return {
      queryName: name,
      count: durations.length,
      errorCount: errors.get(name) ?? 0,
      p50: percentile(durations, 50),
      p95,
      p99: percentile(durations, 99),
      min: durations[0],
      max: durations[durations.length - 1],
      mean: durations.reduce((a, v) => a + v, 0) / durations.length,
      exceedsGate: p95 > WATERMARK_CACHE_GATE_MS,
    }
  }

  return {
    enabled,

    record(queryName, durationMs, ok) {
      if (!enabled) return
      if (!ok) {
        errors.set(queryName, (errors.get(queryName) ?? 0) + 1)
        // A failure's duration is real but not a read latency — counting it
        // in the distribution would make a timeout look like a slow query.
        return
      }
      let list = samples.get(queryName)
      if (!list) {
        list = []
        samples.set(queryName, list)
      }
      list.push({ at: now(), ms: durationMs })
      prune(list)
      // Bounded: an unbounded array on a long-lived process is a leak.
      if (list.length > maxSamples) list.splice(0, list.length - maxSamples)
    },

    async measure(queryName, run) {
      if (!enabled) return run()
      const started = now()
      try {
        const result = await run()
        this.record(queryName, now() - started, true)
        return result
      }
      catch (err) {
        this.record(queryName, now() - started, false)
        throw err
      }
    },

    statsFor(queryName) {
      const list = samples.get(queryName)
      if (!list) return null
      return buildStats(queryName, prune(list))
    },

    report() {
      const queries: QueryLatencyStats[] = []
      for (const [name, list] of samples) {
        const stats = buildStats(name, prune(list))
        if (stats) queries.push(stats)
      }
      queries.sort((a, b) => b.p95 - a.p95)
      return {
        windowMs,
        generatedAt: new Date(now()).toISOString(),
        queries,
        overGate: queries.filter((q) => q.exceedsGate).map((q) => q.queryName),
      }
    },

    reset() {
      samples.clear()
      errors.clear()
    },
  }
}

/**
 * Render a report as a fixed-width table for the pilot write-up.
 *
 * Plain text on purpose — this gets pasted into a ticket or a Slack
 * message, and a JSON blob would not survive that trip readably.
 */
export function formatReport(report: InstrumentationReport): string {
  if (report.queries.length === 0) {
    return 'No query samples recorded.'
  }
  const hours = Math.round(report.windowMs / 3_600_000)
  const rows = report.queries.map((q) => ({
    name: q.queryName,
    n: String(q.count),
    p50: q.p50.toFixed(1),
    p95: q.p95.toFixed(1),
    p99: q.p99.toFixed(1),
    max: q.max.toFixed(1),
    err: String(q.errorCount),
    gate: q.exceedsGate ? ' OVER' : '',
  }))
  const w = (key: keyof (typeof rows)[number], head: string) =>
    Math.max(head.length, ...rows.map((r) => r[key].length))
  const wName = w('name', 'query')

  const lines = [
    `Query latency — rolling ${hours}h, as of ${report.generatedAt}`,
    `${'query'.padEnd(wName)}  ${'n'.padStart(5)}  ${'p50'.padStart(7)}  ${'p95'.padStart(7)}  ${'p99'.padStart(7)}  ${'max'.padStart(7)}  ${'err'.padStart(4)}`,
    '-'.repeat(wName + 44),
    ...rows.map(
      (r) =>
        `${r.name.padEnd(wName)}  ${r.n.padStart(5)}  ${r.p50.padStart(7)}  ${r.p95.padStart(7)}  ${r.p99.padStart(7)}  ${r.max.padStart(7)}  ${r.err.padStart(4)}${r.gate}`
    ),
  ]

  if (report.overGate.length > 0) {
    lines.push(
      '',
      `${report.overGate.length} quer${report.overGate.length === 1 ? 'y' : 'ies'} over the ${WATERMARK_CACHE_GATE_LABEL} gate: ${report.overGate.join(', ')}`,
      'Watermark caching is worth enabling (analytics `watermarkCache: true`).'
    )
  }
  else {
    lines.push(
      '',
      `All queries under the ${WATERMARK_CACHE_GATE_LABEL} gate — leave watermark caching off.`
    )
  }
  return lines.join('\n')
}


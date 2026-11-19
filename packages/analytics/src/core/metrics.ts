/**
 * Metrics: named (table, column) pairs that rules, baselines and tools
 * speak in. Packs declare them (`pack.metrics`); the engine looks them up.
 */

import { packExtensions } from './packs'

/** How often a metric is sampled, in minutes, or once per session. */
export type MetricSampling = number | 'per_session'

export interface MetricDefinition {
  table: string
  column: string
  /** Nominal cadence; the fallback when a device does not report its own. */
  sampling_minutes: MetricSampling
  /** `collected_only`: stored, never offered to rules or tools. */
  exposure: 'full' | 'collected_only'
  /** How validation messages describe the cadence (default `every Nmin`). */
  samplingLabel?: string
  /** Anything else the declaring pack keeps with its metrics. */
  [extra: string]: unknown
}

function all(): Map<string, MetricDefinition> {
  const out = new Map<string, MetricDefinition>()
  for (const metrics of packExtensions<Readonly<Record<string, MetricDefinition>>>('metrics')) {
    for (const [id, def] of Object.entries(metrics)) {
      if (!out.has(id))
        out.set(id, def)
    }
  }
  return out
}

/** One metric, from the first pack that declares it. */
export function metricDefinition(id: string): MetricDefinition | undefined {
  return all().get(id)
}

/** Every registered metric id, in pack then declaration order. */
export function registeredMetricIds(): string[] {
  return [...all().keys()]
}

/** Metrics rules and tools may use (`exposure: 'full'`). */
export function exposedMetricIds(): string[] {
  return [...all()].filter(([, d]) => d.exposure === 'full').map(([id]) => id)
}

/** Columns of `collected_only` metrics, which a raw rule may read only with an override. */
export function collectedOnlyColumns(): string[] {
  return [...new Set([...all().values()].filter(d => d.exposure === 'collected_only').map(d => d.column))]
}

/** How a metric's cadence reads in a message. */
export function samplingLabelFor(id: string): string {
  const def = metricDefinition(id)
  if (def?.samplingLabel)
    return def.samplingLabel
  return def?.sampling_minutes === 'per_session' ? 'once per session' : `every ${def?.sampling_minutes}min`
}

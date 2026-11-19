/**
 * The health pack: ring readings, sleep, device state, and everything the
 * engine needs to know about them. Ships inside `@mongrov/analytics` until
 * package-separation S-03 moves it to `@zivaone/health`.
 *
 * A pack module must not call engine code at load time: the registry loads
 * the default packs lazily, and some engine modules import them back.
 */

import type { AnalyticsPack } from '../../core/packs'
import type { QualityOptions } from './reading-quality'
import { healthBaselines } from './baselines'
import { METRIC_METADATA } from './metrics'
import { HEALTH_MIGRATIONS, healthLegacyVersionKeys, healthVersionKey } from './migrations'
import { dropMalformedRows } from './plausibility'
import { cleanViewFor, fallbackMacroDdl, isQualityTable, qualityMacroDdls, qualityMacroNames, qualityViewDdls, qualityViewFor, qualityViewNames } from './reading-quality'
import { healthRules } from './rule-pack'
import { HEALTH_TABLES } from './tables'
import { healthTools } from './tools'
import { assertNoBanTerms } from './tools/formatters/copy-guidelines'

export const healthPack: AnalyticsPack = {
  name: 'health',
  // Every table validates at ingest (spec §13 S10, T-60): malformed rows are
  // dropped and counted; the reading tables' out-of-range values are kept
  // for `v_*_q` to flag. Tables without a reading column pass through.
  tables: Object.fromEntries(Object.entries(HEALTH_TABLES).map(([name, table]) => [
    name,
    { ...table, validate: (rows: readonly Record<string, unknown>[]) => dropMalformedRows(name, rows) },
  ])),
  migrations: HEALTH_MIGRATIONS,
  // The package ledger every install has applied (steps 1-8), kept so an
  // existing database replays nothing.
  versionKey: healthVersionKey,
  legacyVersionKeys: healthLegacyVersionKeys,
  // Day-first baselines per metric and window, plus HR's phase-band rails.
  baselines: healthBaselines,
  // `v_{table}_q` (per-reading flags) and `v_{table}_clean` (what claims
  // read), plus their bounded `_between` macros (T-25, zivaone_app#121).
  quality: {
    views: options => qualityViewDdls(options as QualityOptions),
    macros: options => qualityMacroDdls(options as QualityOptions),
    fallbackMacro: name => fallbackMacroDdl(name),
    viewNames: () => qualityViewNames(),
    macroNames: () => qualityMacroNames(),
    // Claims read `v_{table}_clean`; the resting gate joins `v_{table}_q`.
    relations: {
      has: table => isQualityTable(table),
      clean: table => cleanViewFor(table as Parameters<typeof cleanViewFor>[0]),
      quality: table => qualityViewFor(table as Parameters<typeof qualityViewFor>[0]),
    },
  },
  // Metric metadata (vitals, steps, sleep, battery); per-session metrics
  // describe their cadence as sleep sessions in validation messages.
  metrics: Object.fromEntries(Object.entries(METRIC_METADATA).map(([id, def]) => [
    id,
    def.sampling_minutes === 'per_session' ? { ...def, samplingLabel: 'once per sleep session' } : def,
  ])),
  // Contexts (asleep, resting), window minimums, D3, settings registry.
  rules: healthRules,
  tools: healthTools,
  // Tool text lands in an LLM's context: no medical vocabulary (Ziva #2).
  copyGuard: (text, source) => assertNoBanTerms(text, source),
}

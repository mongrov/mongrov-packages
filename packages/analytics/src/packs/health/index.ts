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
import { HEALTH_MIGRATIONS, healthLegacyVersionKeys, healthVersionKey } from './migrations'
import { fallbackMacroDdl, qualityMacroDdls, qualityMacroNames, qualityViewDdls, qualityViewNames } from './reading-quality'
import { HEALTH_TABLES } from './tables'

export const healthPack: AnalyticsPack = {
  name: 'health',
  tables: HEALTH_TABLES,
  migrations: HEALTH_MIGRATIONS,
  // The package ledger every install has applied (steps 1-8), kept so an
  // existing database replays nothing.
  versionKey: healthVersionKey,
  legacyVersionKeys: healthLegacyVersionKeys,
  // `v_{table}_q` (per-reading flags) and `v_{table}_clean` (what claims
  // read), plus their bounded `_between` macros (T-25, zivaone_app#121).
  quality: {
    views: options => qualityViewDdls(options as QualityOptions),
    macros: options => qualityMacroDdls(options as QualityOptions),
    fallbackMacro: name => fallbackMacroDdl(name),
    viewNames: () => qualityViewNames(),
    macroNames: () => qualityMacroNames(),
  },
}

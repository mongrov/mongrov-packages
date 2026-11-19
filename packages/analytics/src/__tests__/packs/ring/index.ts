/**
 * The ring test pack: the ZR ring's firmware ingest (mapper) and its SCD-2
 * monitoring-schedule closes, as the engine's sync suites drive them
 * (`sync/__tests__/factory.test.ts`). Writes into the health pack's tables.
 * A trimmed copy of `@zivaone/ring` (zivaone_app): the sleep correction and
 * its post-flush job are not here — the engine suites never ran them, and
 * their tests live with the real pack.
 *
 * A pack module must not call engine code at load time: the registry loads
 * the default packs lazily, and some engine modules import them back.
 */

import type { AnalyticsPack } from '../../../core/packs'
import { firmwareIngestAdapter, ringSyncHooks } from './ingest'

export const ringPack: AnalyticsPack = {
  name: 'ring',
  ingest: { firmware: firmwareIngestAdapter },
  sync: ringSyncHooks,
}

/**
 * The ring pack: the ZR ring's firmware ingest (mapper), its SCD-2
 * monitoring-schedule closes, and (with post-flush jobs) the sleep
 * correction. Writes into the health pack's tables. Ships inside
 * `@mongrov/analytics` until package-separation S-03 moves it to
 * `@zivaone/ring`.
 *
 * A pack module must not call engine code at load time: the registry loads
 * the default packs lazily, and some engine modules import them back.
 */

import type { AnalyticsPack } from '../../core/packs'
import { firmwareIngestAdapter, ringSyncHooks } from './ingest'
import { sleepCorrectionJob } from './sleep-job'

export const ringPack: AnalyticsPack = {
  name: 'ring',
  ingest: { firmware: firmwareIngestAdapter },
  sync: ringSyncHooks,
  postFlush: [sleepCorrectionJob],
}

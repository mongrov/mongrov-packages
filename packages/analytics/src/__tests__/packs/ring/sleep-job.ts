/**
 * Sleep correction as a post-flush job (sleep-correction §3): sessions and
 * stages are derived from `sleep_raw` inside each batch cycle, after the raw
 * tables flush and before `batch:complete`, so rules see whole nights.
 */

import type { PostFlushJob } from '../../../core/packs'
import { createSleepDeriver } from './sleep-derive'

export const sleepCorrectionJob: PostFlushJob = {
  name: 'sleep-correction',
  create(deps) {
    // Needs all three tables subscribed; `correctSleep: false` opts out.
    const { tables, options } = deps
    if (options.correctSleep === false || !['sleep_raw', 'sleep_session', 'sleep_stage'].every(t => tables.includes(t)))
      return undefined
    // Step 5.6 reads the firmware's 10-minute step buckets, as v3.1 did
    // (staging.ts). Without `activity_bucket` subscribed the bucket table never
    // fills, which would read as "no movement" — so fall back to the 1-minute
    // rows, and say so once, rather than correct sleep on silent zero steps.
    const stepBuckets = tables.includes('activity_bucket')
    const deriver = createSleepDeriver({
      engine: deps.engine,
      buffer: deps.buffer,
      flusher: deps.flusher,
      resolveTimezone: deps.resolveTimezone,
      logger: deps.logger,
      activitySteps: stepBuckets ? 'bucket' : 'minute',
    })
    if (!stepBuckets) {
      deps.logger?.warn('sync.factory: activity_bucket not subscribed; sleep correction reads 1-minute steps, not the v3.1 10-minute buckets', {
        tables: tables.length,
      })
    }
    return {
      noteRows(table, batch) {
        if (table === 'sleep_raw')
          deriver.noteRaw(batch)
      },
      run: (batchId, reason) => deriver.derive(batchId, reason),
    }
  },
}

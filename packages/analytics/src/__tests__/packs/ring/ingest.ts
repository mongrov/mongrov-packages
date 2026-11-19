/**
 * The ring's ingest adapter: one firmware export (the JStyle J2301A SDK's
 * JSON) → rows for the health pack's tables. `SensorSink.ingest('firmware',
 * fw, ctx)`, or the older `SensorSink.pushFirmware(fw, ctx)`.
 */

import type { IngestAdapter, PackSyncHooks } from '../../../core/packs'
import type { DeviceConfigRow, FirmwareExport, MapperContext } from './mapper/types'
import { describeError } from '../../../core/errors'
import { CLOSE_DEVICE_CONFIG_SQL, closeDeviceConfigParams, fetchActivePriorConfigs, pushConfigCloses, READ_DEVICE_CONFIG_SQL, readDeviceConfigParams } from './config-closes'
import { mapFirmwareExport } from './mapper/firmware'
import { PendingClosesStore } from './pending-closes'

export const firmwareIngestAdapter: IngestAdapter<FirmwareExport, MapperContext> = {
  async ingest(fw, ctx, deps) {
    // Gated on subscription alone — the mapper owns the translation, so
    // there is no consumer wiring left that could be missing.
    const handlesConfig = deps.tables.includes('device_config')

    // 1) Pre-fetch open configs for this device so the mapper can decide
    //    which metrics need SCD-2 closes. Skipped when we're not
    //    subscribed to device_config.
    const activePriorConfigs = handlesConfig
      ? await fetchActivePriorConfigs(deps, ctx)
      : new Map<string, DeviceConfigRow[]>()

    // 2) Map firmware → mapped batch. The mapper owns the
    //    dataType → metric translation; no consumer translator needed.
    const mapped = mapFirmwareExport(fw, ctx, { activePriorConfigs })

    // 3) SCD-2 close handling. Enqueue-before-UPDATE keeps the local
    //    UPDATE + remote UPDATE replay-safe under crash: both are
    //    idempotent via the `valid_to IS NULL` guard.
    if (handlesConfig && mapped.device_config_closes.length > 0) {
      await new PendingClosesStore(deps.storage).enqueue(deps.attach, mapped.device_config_closes)
      for (const close of mapped.device_config_closes) {
        // Fully-qualified `memory.main.device_config` — the sink runs after
        // `attach()` has called `USE <iceberg>.default`, so 2-part names miss.
        await deps.execute(CLOSE_DEVICE_CONFIG_SQL, closeDeviceConfigParams(close))
      }
    }

    // 3b) An unchanged schedule re-read: no new version, the open row's
    //     `valid_from` becomes the read time (principle 66; see
    //     `mapper/ring-config.ts` for why it moves rather than stays).
    if (handlesConfig) {
      for (const read of mapped.device_config_reads)
        await deps.execute(READ_DEVICE_CONFIG_SQL, readDeviceConfigParams(read))
    }

    // 4) Every mapped table, in buffer order.
    return [
      ['hrv', mapped.hrv],
      ['heart_rate', mapped.heart_rate],
      ['spo2', mapped.spo2],
      ['temperature', mapped.temperature],
      ['activity', mapped.activity],
      ['activity_bucket', mapped.activity_bucket],
      ['sleep_session', mapped.sleep_session],
      ['sleep_stage', mapped.sleep_stage],
      ['sleep_raw', mapped.sleep_raw],
      ['device_event', mapped.device_event],
      ['device_battery', mapped.device_battery],
      ['device_config', mapped.device_config],
    ] as unknown as ReadonlyArray<readonly [string, readonly Record<string, unknown>[]]>
  },
}

/**
 * After each push (r2 mode), replay the SCD-2 closes still pending against
 * the remote `device_config`; a failed or throwing push requeues them.
 */
export const ringSyncHooks: PackSyncHooks = {
  async afterPush(ctx, deps) {
    if (!deps.tables.includes('device_config'))
      return
    const store = new PendingClosesStore(deps.storage)
    const pending = await store.drain(ctx)
    if (pending.length === 0)
      return
    try {
      const result = await pushConfigCloses((table, run) => deps.pushRemote(table, run), pending, ctx)
      if (!result.ok) {
        await store.requeue(ctx, pending)
        deps.logger?.warn('sync.factory: pushCloses failed; requeued', {
          count: pending.length,
          code: (result.error as { code?: string } | undefined)?.code,
          error: result.error ? describeError(result.error) : undefined,
        })
      }
    }
    catch (err) {
      await store.requeue(ctx, pending)
      deps.logger?.warn('sync.factory: pushCloses threw; requeued', {
        count: pending.length,
        err: describeError(err),
      })
    }
  },
}

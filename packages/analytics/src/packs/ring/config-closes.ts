/**
 * The ring's monitoring schedule is stored SCD-2 in `device_config`: a new
 * schedule for a metric closes the open row (`valid_to`) and inserts the new
 * one. Closing happens in two places — the local catalog, at ingest, and the
 * remote one, replayed from `PendingClosesStore` after each push until it
 * lands. Both UPDATEs are idempotent through the `valid_to IS NULL` guard.
 */

import type { IngestContext, IngestDeps } from '../../core/packs'
import type { AttachContext } from '../../core/types'
import type { RingConfigClose } from './mapper/ring-config'
import type { DeviceConfigRow } from './mapper/types'

/**
 * Pre-fetch the currently-open `device_config` rows for the given device
 * so `mapRingConfig` can decide which metrics need SCD-2 closes.
 *
 * Value shape (`DeviceConfigRow`) is not consulted by the mapper — only
 * `.has(dataType)` — but hydrating the row keeps the map future-friendly
 * for logging / diagnostics without a second query.
 */
/**
 * SCD-2 close of one open `device_config` row, local catalog.
 *
 * Hand-written SQL with named placeholders, the same hazard as
 * `ACTIVE_PRIOR_CONFIGS_SQL` below. It read `metric = $data_type` — a
 * leftover of the 0.8.0 `data_type` -> `metric` rename — while the call
 * bound `metric`, so the statement could never execute. Harmless until the
 * app started syncing the ring's monitoring schedule (zivaone_app#190): then
 * every sync whose schedule changed threw here, before its rows were
 * buffered, and the next sync computed the same close and threw again
 * (zivaone_app#221). Every unit test mocked the engine.
 * `__tests__/close-config-sql.test.ts` (unit suite, real DuckDB) now executes it, with the
 * params `closeDeviceConfigParams` builds, against the real DDL.
 */
export const CLOSE_DEVICE_CONFIG_SQL
  = `UPDATE memory.main.device_config\n`
    + `        SET valid_to = $valid_to\n`
    + `      WHERE device_id = $device_id\n`
    + `        AND metric = $metric\n`
    + `        AND valid_to IS NULL`

/** The params `CLOSE_DEVICE_CONFIG_SQL` binds — one builder, so the names cannot drift. */
export function closeDeviceConfigParams(close: { valid_to: Date, device_id: string, metric: string }) {
  return {
    valid_to: close.valid_to.toISOString(),
    device_id: close.device_id,
    metric: close.metric,
  }
}

/**
 * Open (`valid_to IS NULL`) device_config rows for one device.
 *
 * Fully-qualified `memory.main.device_config` so this resolves against the
 * local catalog regardless of the active `USE <iceberg>.default` that
 * `attach()` issues — a 2-part `main.device_config` would resolve against
 * the current (Iceberg) catalog post-attach and miss.
 *
 * Exported so a test can execute it against the real DDL. It is
 * hand-written SQL naming columns explicitly, which means a schema change
 * can silently desync it: the 0.8.0 `data_type` -> `metric` rename did
 * exactly that, and every unit test mocked the response so nothing caught
 * it. `__tests__/prior-configs-sql.integration.test.ts` now runs it against
 * a real table built from LOCAL_SCHEMAS.
 */
export const ACTIVE_PRIOR_CONFIGS_SQL
  = `SELECT device_id, brand, family_id, user_id, metric, interval_minutes, `
    + `start_time, end_time, weeks, valid_from, valid_to\n`
    + `       FROM memory.main.device_config\n`
    + `      WHERE device_id = $device_id\n`
    + `        AND family_id = $family_id\n`
    + `        AND user_id = $user_id\n`
    + `        AND valid_to IS NULL`

export async function fetchActivePriorConfigs(
  engine: Pick<IngestDeps, 'execute'>,
  ctx: Pick<IngestContext, 'deviceId' | 'familyId' | 'userId'>,
): Promise<Map<string, DeviceConfigRow>> {
  // See ACTIVE_PRIOR_CONFIGS_SQL.
  const rows = await engine.execute<Record<string, unknown>>(
    ACTIVE_PRIOR_CONFIGS_SQL,
    {
      device_id: ctx.deviceId,
      family_id: ctx.familyId,
      user_id: ctx.userId,
    },
  )
  const map = new Map<string, DeviceConfigRow>()
  for (const r of rows) {
    const metric = String(r.metric ?? '')
    map.set(metric, {
      brand: String(r.brand ?? ''),
      family_id: String(r.family_id ?? ''),
      user_id: String(r.user_id ?? ''),
      device_id: String(r.device_id ?? ''),
      metric,
      interval_minutes: Number(r.interval_minutes),
      start_time: r.start_time == null ? null : String(r.start_time),
      end_time: r.end_time == null ? null : String(r.end_time),
      weeks: r.weeks == null ? null : Number(r.weeks),
      valid_from: new Date(String(r.valid_from ?? '')),
      valid_to: r.valid_to == null ? null : new Date(String(r.valid_to)),
    })
  }
  return map
}

/** A push of statements to one remote table: `R2Pusher.pushRemote`, bound to a ctx. */
export type RemotePush<R> = (table: string, run: RemoteRun) => Promise<R>
export type RemoteRun = (remoteTable: string, execute: RemoteExecute) => Promise<number>
export type RemoteExecute = (sql: string, params?: Record<string, unknown>) => Promise<unknown>

/**
 * SCD-2 close directives → remote UPDATE (T-08 continuation).
 *
 * Each close becomes:
 *   UPDATE <remote>.device_config
 *      SET valid_to = $valid_to
 *    WHERE device_id = $device_id
 *      AND metric = $metric
 *      AND family_id = $family_id
 *      AND valid_to IS NULL
 *
 * The `valid_to IS NULL` guard makes replaying the same close a no-op,
 * which is what lets the `PendingClosesStore` + scheduler retry cycle
 * survive crashes between local UPDATE and remote UPDATE.
 */
export async function pushConfigCloses<R>(
  push: RemotePush<R>,
  closes: readonly RingConfigClose[],
  ctx: AttachContext,
): Promise<R> {
  return push('device_config', async (remote, execute) => {
    for (const close of closes) {
      await execute(
        `UPDATE ${remote} SET valid_to = $valid_to WHERE device_id = $device_id AND metric = $metric AND family_id = $family_id AND valid_to IS NULL`,
        {
          valid_to: close.valid_to.toISOString(),
          device_id: close.device_id,
          metric: close.metric,
          family_id: ctx.tenantId,
        },
      )
    }
    return closes.length
  })
}

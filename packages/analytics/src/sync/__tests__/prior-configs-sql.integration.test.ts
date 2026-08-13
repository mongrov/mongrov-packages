/**
 * Hand-written SQL ↔ DDL contract, for the SCD-2 prior-config lookup.
 *
 * `ACTIVE_PRIOR_CONFIGS_SQL` names `device_config` columns explicitly, which
 * makes it silently desyncable from `core/schemas.ts`. The 0.8.0
 * `data_type` → `metric` rename did exactly that and nothing caught it:
 * every unit test mocks the engine's response, so the query string is never
 * executed against a real table, and the integration suite happened not to
 * exercise this path.
 *
 * This runs it against a real DuckDB table built from `LOCAL_SCHEMAS`. A
 * column rename now fails here instead of at a user's first ring sync.
 *
 * Uses the real engine but no MinIO — it only needs local DuckDB.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { LOCAL_SCHEMAS } from '../../core/schemas'
import { ACTIVE_PRIOR_CONFIGS_SQL } from '../factory'

const PARAMS = {
  device_id: 'ring_1',
  family_id: 'fam_A',
  user_id: 'u1',
}

describe('ACTIVE_PRIOR_CONFIGS_SQL ↔ device_config DDL', () => {
  it('executes against a table built from LOCAL_SCHEMAS', async () => {
    const db = await createRealDuckDB(['icu'])
    try {
      await db.execute(
        LOCAL_SCHEMAS.device_config.replace(
          'CREATE TABLE device_config',
          'CREATE TABLE memory.main.device_config',
        ),
      )
      // The assertion is simply that this does not throw: DuckDB rejects an
      // unknown column at bind time, which is the failure mode being guarded.
      const rows = await db.execute(ACTIVE_PRIOR_CONFIGS_SQL, PARAMS)
      expect(rows).toEqual([])
    }
    finally {
      await db.close()
    }
  })

  it('projects every column the row mapper reads back', async () => {
    const db = await createRealDuckDB(['icu'])
    try {
      await db.execute(
        LOCAL_SCHEMAS.device_config.replace(
          'CREATE TABLE device_config',
          'CREATE TABLE memory.main.device_config',
        ),
      )
      await db.execute(
        `INSERT INTO memory.main.device_config
           (device_id, brand, family_id, user_id, metric, interval_minutes,
            start_time, end_time, weeks, valid_from, valid_to)
         VALUES ($device_id, 'ziva', $family_id, $user_id, 'hrv', 5,
                 '22:00', '08:00', 127, now(), NULL)`,
        PARAMS,
      )

      const rows = await db.execute<Record<string, unknown>>(
        ACTIVE_PRIOR_CONFIGS_SQL,
        PARAMS,
      )
      expect(rows).toHaveLength(1)

      // These are exactly the fields `fetchActivePriorConfigs` reads off the
      // row to rebuild a DeviceConfigRow. A projection that dropped one
      // would surface as an undefined column here.
      for (const col of [
        'device_id',
        'brand',
        'family_id',
        'user_id',
        'metric',
        'interval_minutes',
        'start_time',
        'end_time',
        'weeks',
        'valid_from',
        'valid_to',
      ]) {
        expect(rows[0], `missing projected column ${col}`).toHaveProperty(col)
      }
      expect(rows[0].metric).toBe('hrv')
    }
    finally {
      await db.close()
    }
  })

  it('filters out closed configs', async () => {
    const db = await createRealDuckDB(['icu'])
    try {
      await db.execute(
        LOCAL_SCHEMAS.device_config.replace(
          'CREATE TABLE device_config',
          'CREATE TABLE memory.main.device_config',
        ),
      )
      await db.execute(
        `INSERT INTO memory.main.device_config
           (device_id, brand, family_id, user_id, metric, interval_minutes,
            start_time, end_time, weeks, valid_from, valid_to)
         VALUES ($device_id, 'ziva', $family_id, $user_id, 'hrv', 5,
                 NULL, NULL, NULL, now(), now())`,
        PARAMS,
      )
      expect(await db.execute(ACTIVE_PRIOR_CONFIGS_SQL, PARAMS)).toEqual([])
    }
    finally {
      await db.close()
    }
  })
})

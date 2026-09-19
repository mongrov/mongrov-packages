/**
 * Hand-written SQL ↔ DDL contract, for the SCD-2 close (zivaone_app#221).
 *
 * `CLOSE_DEVICE_CONFIG_SQL` read `metric = $data_type` while the sink bound
 * `metric`, so it threw on every sync whose ring schedule changed. Every unit
 * test mocked the engine. This executes it — with the exact params the sink
 * builds — against a real table from `LOCAL_SCHEMAS`.
 */

import { describe, expect, it } from 'vitest'

import { createRealDuckDB } from '../../__integration__/setup/real-engine'
import { LOCAL_SCHEMAS } from '../../core/schemas'
import { CLOSE_DEVICE_CONFIG_SQL, closeDeviceConfigParams } from '../factory'

async function boot() {
  const db = await createRealDuckDB(['icu'])
  await db.execute(LOCAL_SCHEMAS.device_config.replace('CREATE TABLE device_config', 'CREATE TABLE memory.main.device_config'))
  for (const metric of ['spo2', 'heart_rate']) {
    await db.execute(
      `INSERT INTO memory.main.device_config
         (device_id, brand, family_id, user_id, metric, interval_minutes, start_time, end_time, weeks, valid_from, valid_to)
       VALUES ('ring_1', 'ziva', 'fam', 'u1', '${metric}', 30, NULL, NULL, NULL, TIMESTAMP '2026-09-01 00:00:00', NULL)`,
    )
  }
  return db
}

describe('CLOSE_DEVICE_CONFIG_SQL ↔ device_config DDL', () => {
  it('closes exactly the open row for that device and metric, with the sink\'s own params', async () => {
    const db = await boot()
    try {
      await db.execute(CLOSE_DEVICE_CONFIG_SQL, closeDeviceConfigParams({
        valid_to: new Date('2026-09-19T11:19:00Z'),
        device_id: 'ring_1',
        metric: 'spo2',
      }))
      const rows = await db.execute<{ metric: string, valid_to: string | null }>(
        `SELECT metric, valid_to::VARCHAR AS valid_to FROM memory.main.device_config ORDER BY metric`,
      )
      expect(rows).toEqual([
        { metric: 'heart_rate', valid_to: null },
        // Naive UTC, the column family's convention.
        { metric: 'spo2', valid_to: '2026-09-19 11:19:00' },
      ])
    }
    finally {
      await db.close()
    }
  })

  it('is idempotent: a replayed close changes nothing (the pending-closes replay)', async () => {
    const db = await boot()
    try {
      const params = closeDeviceConfigParams({ valid_to: new Date('2026-09-19T11:19:00Z'), device_id: 'ring_1', metric: 'spo2' })
      await db.execute(CLOSE_DEVICE_CONFIG_SQL, params)
      await db.execute(CLOSE_DEVICE_CONFIG_SQL, { ...params, valid_to: new Date('2026-09-20T00:00:00Z').toISOString() })
      const rows = await db.execute<{ valid_to: string }>(
        `SELECT valid_to::VARCHAR AS valid_to FROM memory.main.device_config WHERE metric = 'spo2'`,
      )
      expect(rows).toEqual([{ valid_to: '2026-09-19 11:19:00' }])
    }
    finally {
      await db.close()
    }
  })
})

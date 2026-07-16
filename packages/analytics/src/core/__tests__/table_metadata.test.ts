/**
 * Unit coverage for the TABLE_METADATA registry.
 *
 * Locks in the two invariants the pusher/fetcher depend on:
 *   1. Every warehouse table in `TABLE_NAMES` has a metadata entry.
 *   2. Known non-`ts` tables (`sleep_session`, `device_config`,
 *      `sync_watermark`) get their spec-correct time column.
 */

import { describe, expect, it } from 'vitest'

import { TABLE_NAMES } from '../schemas'
import { isSyncable, TABLE_METADATA, timeColumnFor } from '../table_metadata'

describe('TABLE_METADATA', () => {
  it('has an entry for every table in TABLE_NAMES', () => {
    for (const table of TABLE_NAMES) {
      expect(TABLE_METADATA[table], `missing metadata for ${table}`).toBeDefined()
      expect(typeof TABLE_METADATA[table].timeColumn).toBe('string')
      expect(typeof TABLE_METADATA[table].syncable).toBe('boolean')
    }
  })

  it('maps non-ts sync columns per spec', () => {
    expect(TABLE_METADATA.sleep_session.timeColumn).toBe('ts_start')
    expect(TABLE_METADATA.device_config.timeColumn).toBe('valid_from')
    expect(TABLE_METADATA.sync_watermark.timeColumn).toBe('updated_at')
  })

  it('marks pure-local tables as non-syncable', () => {
    expect(TABLE_METADATA.sync_watermark.syncable).toBe(false)
    expect(TABLE_METADATA.tool_call_audit.syncable).toBe(false)
  })

  it('marks warehouse-shared tables as syncable', () => {
    expect(TABLE_METADATA.hrv.syncable).toBe(true)
    expect(TABLE_METADATA.sleep_session.syncable).toBe(true)
    expect(TABLE_METADATA.device_config.syncable).toBe(true)
    expect(TABLE_METADATA.insight.syncable).toBe(true)
  })

  it('is frozen', () => {
    expect(Object.isFrozen(TABLE_METADATA)).toBe(true)
  })
})

describe('timeColumnFor', () => {
  it('returns registered columns for known tables', () => {
    expect(timeColumnFor('hrv')).toBe('ts')
    expect(timeColumnFor('sleep_session')).toBe('ts_start')
    expect(timeColumnFor('device_config')).toBe('valid_from')
  })

  it('falls back to `ts` for unknown tables', () => {
    expect(timeColumnFor('unknown_table')).toBe('ts')
  })
})

describe('isSyncable', () => {
  it('reflects the registry flag', () => {
    expect(isSyncable('hrv')).toBe(true)
    expect(isSyncable('sync_watermark')).toBe(false)
    expect(isSyncable('tool_call_audit')).toBe(false)
  })

  it('returns false for unknown tables (fail-closed)', () => {
    expect(isSyncable('unknown_table')).toBe(false)
  })
})

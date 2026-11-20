/**
 * `@mongrov/analytics/testing`: the pure modules an app's test double of the
 * package re-exports. Same objects as the root and `/sync` exports (one
 * registry), no native module, no React, no side effect on import.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as root from '../index'
import * as rules from '../rules'
import * as sync from '../sync'
import * as testing from '../testing'

/** The runtime exports, by name. */
const EXPECTED = [
  'AnalyticsError',
  'BOUNDED_FAILURE_LIMIT',
  'DROPPED_ROWS_EVENT',
  'DropTally',
  'FORWARD_DAYS',
  'NotImplementedError',
  'PLATFORM_SCHEMAS',
  'PLATFORM_TABLES',
  'PLATFORM_TABLE_NAMES',
  'REMOTE_NAMESPACE',
  'SPARE_DAYS',
  'addIdentityKey',
  'appSchemaVersionKey',
  'boundedRelation',
  'cleanRelation',
  'collectedOnlyColumns',
  'createBaselineRunner',
  'daysInterval',
  'definePack',
  'describeError',
  'dropViewDdl',
  'ensureAppSchema',
  'ensureSchemas',
  'executeBounded',
  'executeBoundedRead',
  'exposedMetricIds',
  'generateViewDdl',
  'getPack',
  'getPacks',
  'hasLocalPrimaryKey',
  'hasQualityRelations',
  'hoursInterval',
  'ingestAdapter',
  'isSyncable',
  'listColumns',
  'localDdlFor',
  'logError',
  'mergeFlushResults',
  'metricDefinition',
  'packExtensions',
  'packTable',
  'packTables',
  'qualifyDdl',
  'qualityRelation',
  'quoteQualifier',
  'readRelation',
  'registerPack',
  'registerPacks',
  'registeredMetricIds',
  'resetPacks',
  'samplingLabelFor',
  'tailId',
  'timeColumnFor',
  'toLocalDdl',
  'userSettingKey',
  'validateAppSchema',
  'validateRows',
  'viewedTables',
  'watermarkColumnFor',
]

describe('@mongrov/analytics/testing', () => {
  afterEach(() => {
    vi.doUnmock('react')
    vi.doUnmock('react-native-duckdb')
    vi.doUnmock('xstate')
    vi.resetModules()
  })

  it('exports exactly the documented runtime names', () => {
    expect(Object.keys(testing).sort()).toEqual([...EXPECTED].sort())
  })

  it('each export is the root, /sync or /rules export of the same name (one module instance)', () => {
    const publicSurface: Record<string, unknown> = { ...root, ...sync, ...rules }
    for (const name of EXPECTED) {
      if (name === 'resetPacks')
        continue // only here: test isolation for an app's pack registrations
      expect(testing[name as keyof typeof testing], name).toBe(publicSurface[name])
    }
  })

  it('loads without React, the DuckDB native module or the state machine', async () => {
    const forbidden = (id: string) => () => {
      throw new Error(`@mongrov/analytics/testing must not load ${id}`)
    }
    vi.doMock('react', forbidden('react'))
    vi.doMock('react-native-duckdb', forbidden('react-native-duckdb'))
    vi.doMock('xstate', forbidden('xstate'))
    vi.resetModules()
    const fresh = await import('../testing')
    expect(typeof fresh.definePack).toBe('function')
  })

  it('userSettingKey is the key the rules engine reads', () => {
    expect(testing.userSettingKey('u1', 'user:alertLevel')).toBe('analytics:u1:user:alertLevel')
  })
})

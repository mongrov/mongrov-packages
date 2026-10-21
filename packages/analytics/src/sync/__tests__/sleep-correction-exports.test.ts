import { describe, expect, it } from 'vitest'

import {
  correctSleepNights,
  nightsForEpochs,
  SLEEP_CORRECTION_RELATIONS,
  sleepStagingBoundsFor,
  sleepStagingViewsSql,
} from '../index'

// The app's native smoke runs this path on the device build (zivaone_app#460).
describe('sync barrel: sleep-correction read path', () => {
  it('exports the pieces sleep-derive composes', () => {
    expect(typeof correctSleepNights).toBe('function')
    expect(typeof nightsForEpochs).toBe('function')
    expect(typeof sleepStagingBoundsFor).toBe('function')
    expect(SLEEP_CORRECTION_RELATIONS).toEqual({ sleep: 'stg_sleep', heartrate: 'stg_heartrate', activity: 'stg_activity' })
  })

  it('names the caller\'s relations, never the defaults, when given its own', () => {
    const own = { sleep: 'smoke_sleep', heartrate: 'smoke_heartrate', activity: 'smoke_activity' }
    const sql = sleepStagingViewsSql({ brand: 'b', familyId: 'f', userId: 'u', deviceId: 'd', localCatalog: 'local' }, own).join('\n')
    expect(sql).toContain('TEMP VIEW smoke_sleep')
    expect(sql).toContain('TEMP VIEW smoke_heartrate')
    expect(sql).toContain('TEMP VIEW smoke_activity')
    expect(sql).not.toContain('stg_')
  })

  it('cannot be redirected through the exported defaults', () => {
    expect(Object.isFrozen(SLEEP_CORRECTION_RELATIONS)).toBe(true)
    expect(() => {
      (SLEEP_CORRECTION_RELATIONS as { sleep: string }).sleep = 'elsewhere'
    }).toThrow()
  })

  it('rejects a relation name that is not an identifier before writing any SQL', () => {
    const scope = { brand: 'b', familyId: 'f', userId: 'u', deviceId: 'd', localCatalog: 'local' }
    expect(() => sleepStagingViewsSql(scope, { sleep: 'x; DROP TABLE y', heartrate: 'h', activity: 'a' }))
      .toThrow(/invalid relation name/)
  })
})

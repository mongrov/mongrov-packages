import { describe, expect, it } from 'vitest'
import { createFakeClock } from '../__fakes__/fakeClock'
import { createFakeStorage } from '../__fakes__/fakeStorage'
import { createThrottleStore } from '../throttle'

const throttle = { minGapMinutes: 60, maxPerDay: 3 }

describe('throttle store', () => {
  it('allows the first fire, blocks within min-gap', async () => {
    const storage = createFakeStorage()
    const clock = createFakeClock('2025-01-01T00:00:00Z')
    const store = createThrottleStore({ storage, clock })

    expect(await store.isThrottled('r1', 'u1', throttle)).toBe(false)
    await store.recordFire('r1', 'u1')

    clock.advance(30 * 60_000)
    expect(await store.isThrottled('r1', 'u1', throttle)).toBe(true)

    clock.advance(31 * 60_000)
    expect(await store.isThrottled('r1', 'u1', throttle)).toBe(false)
  })

  it('respects daily cap', async () => {
    const storage = createFakeStorage()
    const clock = createFakeClock('2025-01-01T00:00:00Z')
    const store = createThrottleStore({ storage, clock })

    for (let i = 0; i < 3; i++) {
      expect(await store.isThrottled('r2', 'u1', throttle)).toBe(false)
      await store.recordFire('r2', 'u1')
      clock.advance(61 * 60_000)
    }
    // 4th attempt within same day → blocked by count
    expect(await store.isThrottled('r2', 'u1', throttle)).toBe(true)
  })

  it('resets daily count after midnight UTC', async () => {
    const storage = createFakeStorage()
    const clock = createFakeClock('2025-01-01T00:00:00Z')
    const store = createThrottleStore({ storage, clock })

    for (let i = 0; i < 3; i++) {
      await store.recordFire('r3', 'u1')
      clock.advance(61 * 60_000)
    }
    expect(await store.isThrottled('r3', 'u1', throttle)).toBe(true)

    // Jump to next UTC day
    clock.set('2025-01-02T00:01:00Z')
    expect(await store.isThrottled('r3', 'u1', throttle)).toBe(false)
  })

  it('purges stale daily-count keys on next-day read', async () => {
    const storage = createFakeStorage()
    const clock = createFakeClock('2025-01-01T00:00:00Z')
    const store = createThrottleStore({ storage, clock })

    await store.recordFire('r4', 'u1')
    clock.set('2025-01-02T00:01:00Z')
    await store.isThrottled('r4', 'u1', throttle)

    const dump = storage.__dump()
    expect(
      dump['analytics:rules:throttle:r4:u1:count:2025-01-01'],
    ).toBeUndefined()
  })

  it('is per-user independent', async () => {
    const storage = createFakeStorage()
    const clock = createFakeClock('2025-01-01T00:00:00Z')
    const store = createThrottleStore({ storage, clock })

    await store.recordFire('r5', 'userA')
    expect(await store.isThrottled('r5', 'userA', throttle)).toBe(true)
    expect(await store.isThrottled('r5', 'userB', throttle)).toBe(false)
  })
})

import type { AttachContext } from '../types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createActor } from 'xstate'
import { analyticsMachine, computeRefreshDelay } from '../machine'

import { createFakeMachineActors } from './__fakes__/fake-machine-actors'

/**
 * Wait for pending microtasks so promise `.then` handlers registered by the
 * XState actor pipeline flush before we assert on state.
 */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await Promise.resolve()
  }
}

const ATTACH_CTX: AttachContext = {
  brand: 'brandA',
  tenantScope: 'family',
  tenantId: 'fam123',
  userId: 'user-1',
}

describe('analyticsMachine — happy paths', () => {
  it('idle → OPEN → opening → success → ready', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    expect(actor.getSnapshot().value).toBe('idle')

    actor.send({ type: 'OPEN' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(fakes.openCalls).toBe(1)

    fakes.openDeferreds[0].resolve()
    await flush()

    expect(actor.getSnapshot().value).toBe('ready')
    actor.stop()
  })

  it('ready → ATTACH → attaching → success → attached with ctx + secret', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].resolve()
    await flush()

    actor.send({ type: 'ATTACH', ctx: ATTACH_CTX })
    expect(actor.getSnapshot().value).toBe('attaching')
    expect(fakes.attachCalls).toEqual([ATTACH_CTX])

    fakes.attachDeferreds[0].resolve({
      warehouseSecret: 'zone_fam123',
      tokenExpiresAt: Date.now() + 60 * 60 * 1000,
    })
    await flush()

    expect(actor.getSnapshot().value).toBe('attached')
    expect(actor.getSnapshot().context.warehouseSecret).toBe('zone_fam123')
    expect(actor.getSnapshot().context.ctx).toEqual(ATTACH_CTX)
    actor.stop()
  })

  it('attached → DETACH → detaching → success → ready with cleared ctx', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].resolve()
    await flush()

    actor.send({ type: 'ATTACH', ctx: ATTACH_CTX })
    fakes.attachDeferreds[0].resolve({
      warehouseSecret: 'zone_fam123',
      tokenExpiresAt: Date.now() + 3600_000,
    })
    await flush()

    actor.send({ type: 'DETACH' })
    expect(actor.getSnapshot().value).toBe('detaching')
    fakes.detachDeferreds[0].resolve()
    await flush()

    expect(actor.getSnapshot().value).toBe('ready')
    expect(actor.getSnapshot().context.ctx).toBeUndefined()
    expect(actor.getSnapshot().context.warehouseSecret).toBeUndefined()
    actor.stop()
  })
})

describe('analyticsMachine — error paths', () => {
  it('open failure lands in error with lastError.code=engine_open_failed', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].reject(new Error('boom'))
    await flush()

    expect(actor.getSnapshot().value).toBe('error')
    expect(actor.getSnapshot().context.lastError?.code).toBe('engine_open_failed')
    actor.stop()
  })

  it('attach failure lands in error with lastError.code=attach_failed', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].resolve()
    await flush()

    actor.send({ type: 'ATTACH', ctx: ATTACH_CTX })
    fakes.attachDeferreds[0].reject(new Error('vendor down'))
    await flush()

    expect(actor.getSnapshot().value).toBe('error')
    expect(actor.getSnapshot().context.lastError?.code).toBe('attach_failed')
    actor.stop()
  })

  it('error → OPEN → opening (recoverable)', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].reject(new Error('boom'))
    await flush()
    expect(actor.getSnapshot().value).toBe('error')

    actor.send({ type: 'OPEN' })
    expect(actor.getSnapshot().value).toBe('opening')
    expect(actor.getSnapshot().context.lastError).toBeUndefined()
    actor.stop()
  })
})

describe('analyticsMachine — token refresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('attached fires TOKEN_REFRESH after ~75% TTL and re-arms on success', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].resolve()
    await flush()

    const now = Date.now()
    const ttlMs = 60 * 60 * 1000
    actor.send({ type: 'ATTACH', ctx: ATTACH_CTX })
    fakes.attachDeferreds[0].resolve({
      warehouseSecret: 'zone_fam123',
      tokenExpiresAt: now + ttlMs,
    })
    await flush()

    expect(actor.getSnapshot().value).toBe('attached')

    // Fast-forward 75% of TTL.
    await vi.advanceTimersByTimeAsync(Math.floor(ttlMs * 0.75))
    expect(actor.getSnapshot().value).toBe('refreshing')
    expect(fakes.refreshCalls).toHaveLength(1)

    // Refresh succeeds with a new TTL — machine re-enters attached.
    fakes.refreshDeferreds[0].resolve({ tokenExpiresAt: Date.now() + ttlMs })
    await flush()
    expect(actor.getSnapshot().value).toBe('attached')

    actor.stop()
  })

  it('refresh failure transitions to error with lastError.code=token_vendor_failed', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].resolve()
    await flush()

    const ttlMs = 60 * 60 * 1000
    actor.send({ type: 'ATTACH', ctx: ATTACH_CTX })
    fakes.attachDeferreds[0].resolve({
      warehouseSecret: 'zone_fam123',
      tokenExpiresAt: Date.now() + ttlMs,
    })
    await flush()

    await vi.advanceTimersByTimeAsync(Math.floor(ttlMs * 0.75))
    expect(actor.getSnapshot().value).toBe('refreshing')

    fakes.refreshDeferreds[0].reject(new Error('token 401'))
    await flush()
    expect(actor.getSnapshot().value).toBe('error')
    expect(actor.getSnapshot().context.lastError?.code).toBe('token_vendor_failed')

    actor.stop()
  })
})

describe('analyticsMachine — CLOSE from any state', () => {
  it('CLOSE from attached returns to idle and clears attach state', async () => {
    const fakes = createFakeMachineActors()
    const actor = createActor(analyticsMachine, { input: { deps: fakes.actors } })
    actor.start()

    actor.send({ type: 'OPEN' })
    fakes.openDeferreds[0].resolve()
    await flush()

    actor.send({ type: 'ATTACH', ctx: ATTACH_CTX })
    fakes.attachDeferreds[0].resolve({
      warehouseSecret: 'zone_fam123',
      tokenExpiresAt: Date.now() + 3600_000,
    })
    await flush()

    actor.send({ type: 'CLOSE' })
    expect(actor.getSnapshot().value).toBe('idle')
    expect(actor.getSnapshot().context.ctx).toBeUndefined()
    expect(actor.getSnapshot().context.warehouseSecret).toBeUndefined()
    actor.stop()
  })
})

describe('computeRefreshDelay', () => {
  it('returns 75% of remaining TTL', () => {
    const now = 1_000_000
    const expiresAt = now + 60 * 60 * 1000 // 1h
    expect(computeRefreshDelay(now, expiresAt)).toBe(Math.floor(60 * 60 * 1000 * 0.75))
  })

  it('falls back to 30 minutes when expiresAt is undefined or past', () => {
    const now = 1_000_000
    expect(computeRefreshDelay(now, undefined)).toBe(30 * 60 * 1000)
    expect(computeRefreshDelay(now, now - 100)).toBe(30 * 60 * 1000)
  })

  it('caps at 2^31-1 ms so far-future sentinels do not overflow setTimeout', () => {
    // Local mode's attachLocal returns a 100-year expiry; a raw 75% of
    // that overflows the 32-bit timer int and Node/Hermes clamp it to
    // ~1ms — firing the refresh constantly instead of never.
    const now = 1_000_000
    const farFuture = now + 100 * 365 * 24 * 60 * 60 * 1000
    expect(computeRefreshDelay(now, farFuture)).toBe(2 ** 31 - 1)
  })
})

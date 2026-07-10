/**
 * Scriptable fake for `MachineActors`, driving the T-09 machine tests.
 *
 * Each actor resolves a manual `Deferred` — tests grant success/failure
 * explicitly so we can observe intermediate states (opening, attaching,
 * refreshing, detaching) without racing timers.
 */

import type { AttachContext } from '../../types'
import type { AttachSuccess, MachineActors, RefreshSuccess } from '../../machine'

export interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: unknown) => void
  settled: boolean
}

export function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  const d = {
    promise,
    resolve(value: T) {
      d.settled = true
      resolve(value)
    },
    reject(err: unknown) {
      d.settled = true
      reject(err)
    },
    settled: false,
  }
  return d
}

export interface FakeMachineActors {
  actors: MachineActors
  openCalls: number
  attachCalls: AttachContext[]
  detachCalls: AttachContext[]
  refreshCalls: AttachContext[]
  /** Deferred slots — one per pending call. */
  openDeferreds: Deferred<void>[]
  attachDeferreds: Deferred<AttachSuccess>[]
  detachDeferreds: Deferred<void>[]
  refreshDeferreds: Deferred<RefreshSuccess>[]
}

export function createFakeMachineActors(): FakeMachineActors {
  const state: FakeMachineActors = {
    actors: {} as MachineActors,
    openCalls: 0,
    attachCalls: [],
    detachCalls: [],
    refreshCalls: [],
    openDeferreds: [],
    attachDeferreds: [],
    detachDeferreds: [],
    refreshDeferreds: [],
  }

  state.actors = {
    openEngine: () => {
      state.openCalls += 1
      const d = createDeferred<void>()
      state.openDeferreds.push(d)
      return d.promise
    },
    attachEngine: ({ ctx }) => {
      state.attachCalls.push(ctx)
      const d = createDeferred<AttachSuccess>()
      state.attachDeferreds.push(d)
      return d.promise
    },
    detachEngine: ({ ctx }) => {
      state.detachCalls.push(ctx)
      const d = createDeferred<void>()
      state.detachDeferreds.push(d)
      return d.promise
    },
    refreshToken: ({ ctx }) => {
      state.refreshCalls.push(ctx)
      const d = createDeferred<RefreshSuccess>()
      state.refreshDeferreds.push(d)
      return d.promise
    },
  }

  return state
}

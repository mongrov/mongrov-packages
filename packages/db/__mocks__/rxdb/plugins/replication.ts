/**
 * Mock for rxdb/plugins/replication
 *
 * Provides mock implementation for testing replication.
 */

import { BehaviorSubject, Subject } from 'rxjs'

interface MockReplicationState {
  replicationIdentifier: string
  collection: unknown
  active$: BehaviorSubject<boolean>
  error$: Subject<Error>
  canceled: boolean
  cancel: () => Promise<void>
  reSync: () => Promise<void>
  awaitInitialReplication: () => Promise<void>
  awaitInSync: () => Promise<void>
  // Store handlers for testing
  _pushHandler?: (docs: unknown[]) => Promise<void>
  _pullHandler?: (
    checkpoint: unknown,
    batchSize: number
  ) => Promise<{ documents: unknown[]; checkpoint: unknown }>
  // Trigger methods for testing
  _triggerPush: (docs: unknown[]) => Promise<void>
  _triggerPull: (checkpoint: unknown, batchSize: number) => Promise<{ documents: unknown[]; checkpoint: unknown }>
  _emitError: (error: Error) => void
}

// Store created replication states for testing
const replicationStates: Map<string, MockReplicationState> = new Map()

export function replicateRxCollection(options: {
  replicationIdentifier: string
  collection: unknown
  push?: {
    handler: (docs: unknown[]) => Promise<void>
    batchSize?: number
  }
  pull?: {
    handler: (checkpoint: unknown, batchSize: number) => Promise<{ documents: unknown[]; checkpoint: unknown }>
    batchSize?: number
  }
  autoStart?: boolean
  retryTime?: number
  live?: boolean
}): MockReplicationState {
  const active$ = new BehaviorSubject<boolean>(options.autoStart !== false)
  const error$ = new Subject<Error>()

  const state: MockReplicationState = {
    replicationIdentifier: options.replicationIdentifier,
    collection: options.collection,
    active$,
    error$,
    canceled: false,

    async cancel() {
      this.canceled = true
      active$.next(false)
      active$.complete()
      error$.complete()
      replicationStates.delete(options.replicationIdentifier)
    },

    async reSync() {
      if (this.canceled) {
        throw new Error('Cannot reSync canceled replication')
      }
      active$.next(true)
    },

    async awaitInitialReplication() {
      // In mock, this resolves immediately
    },

    async awaitInSync() {
      // In mock, this resolves immediately
    },

    _pushHandler: options.push?.handler,
    _pullHandler: options.pull?.handler,

    async _triggerPush(docs: unknown[]) {
      if (!this._pushHandler) {
        throw new Error('Push handler not configured')
      }
      await this._pushHandler(docs)
    },

    async _triggerPull(checkpoint: unknown, batchSize: number) {
      if (!this._pullHandler) {
        throw new Error('Pull handler not configured')
      }
      return this._pullHandler(checkpoint, batchSize)
    },

    _emitError(error: Error) {
      error$.next(error)
    },
  }

  replicationStates.set(options.replicationIdentifier, state)
  return state
}

// Test helpers
export function __getReplicationState(identifier: string): MockReplicationState | undefined {
  return replicationStates.get(identifier)
}

export function __clearAllReplications(): void {
  for (const state of replicationStates.values()) {
    state.cancel()
  }
  replicationStates.clear()
}

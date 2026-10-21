/**
 * RxDB Replication Helper
 *
 * Thin wrapper over rxdb/plugins/replication for creating replication states.
 * App provides push/pull handlers that connect to their backend (e.g., collab adapter).
 */

import type {
  DBLogger,
  ReplicationConfig,
  RxReplicationStateType,
} from './types'

import { replicateRxCollection } from 'rxdb/plugins/replication'
import { describeError, noopLogger } from './logger'

/**
 * Creates a replication state for syncing a collection with a remote backend.
 *
 * This is a thin wrapper over RxDB's replication plugin. The app provides
 * push/pull handlers that connect to their backend (e.g., @mongrov/collab adapter).
 *
 * @param config - Replication configuration
 * @returns RxDB replication state instance
 *
 * @example
 * ```typescript
 * import { createReplicationState } from '@mongrov/db'
 *
 * // Create replication with push/pull handlers
 * const replication = createReplicationState({
 *   replicationIdentifier: 'messages-sync',
 *   collection: db.messages,
 *   push: {
 *     handler: async (docs) => {
 *       // Send changes to backend via collab adapter
 *       await collabAdapter.pushMessages(docs)
 *     },
 *   },
 *   pull: {
 *     handler: async (checkpoint, batchSize) => {
 *       // Fetch changes from backend
 *       const result = await collabAdapter.pullMessages(checkpoint, batchSize)
 *       return {
 *         documents: result.messages,
 *         checkpoint: result.checkpoint,
 *       }
 *     },
 *   },
 *   live: true, // Enable real-time sync
 * })
 *
 * // Listen for sync events
 * // Errors are already reported to `logger`; subscribe for UI state.
 * replication.error$.subscribe((error) => {
 *   setSyncError(error)
 * })
 *
 * // Manual sync trigger
 * await replication.reSync()
 *
 * // Stop replication
 * await replication.cancel()
 * ```
 */
export function createReplicationState<T>(
  config: ReplicationConfig<T>,
): RxReplicationStateType {
  const {
    replicationIdentifier,
    collection,
    push,
    pull,
    autoStart = true,
    retryTime = 0,
    live = false,
    logger = noopLogger,
  } = config

  logger.info('Creating replication state', {
    replicationIdentifier,
    hasPush: !!push,
    hasPull: !!pull,
    live,
  })

  // Build RxDB replication options

  const replicationOptions: any = {
    replicationIdentifier,
    collection,
    autoStart,
    retryTime,
    live,
  }

  // Add push handler if provided
  if (push) {
    replicationOptions.push = {
      batchSize: push.batchSize ?? 100,
      handler: async (docs: T[]) => {
        try {
          await push.handler(docs)
          logger.debug('Push complete', { replicationIdentifier, count: (docs as unknown[]).length })
        }
        catch (error) {
          // Rethrown so RxDB retries and emits error$ (logged below).
          logger.error('Push failed', {
            replicationIdentifier,
            count: (docs as unknown[]).length,
            error: describeError(error),
          })
          throw error
        }
      },
    }
  }

  // Add pull handler if provided
  if (pull) {
    replicationOptions.pull = {
      batchSize: pull.batchSize ?? 100,
      handler: async (
        lastCheckpoint: Record<string, unknown> | null,
        batchSize: number,
      ) => {
        try {
          const result = await pull.handler(lastCheckpoint, batchSize)
          logger.debug('Pull complete', { replicationIdentifier, count: result.documents.length })
          return result
        }
        catch (error) {
          // Rethrown so RxDB retries and emits error$ (logged below).
          logger.error('Pull failed', { replicationIdentifier, batchSize, error: describeError(error) })
          throw error
        }
      },
    }
  }

  const replicationState = replicateRxCollection(replicationOptions)

  // Log replication events
  replicationState.error$.subscribe((error: Error) => {
    logger.error('Replication error', { replicationIdentifier, error: error?.message ?? String(error) })
  })

  // One line per sync cycle (active → idle), not per batch.
  let cycleStartedAt: number | null = null
  replicationState.active$.subscribe((active: boolean) => {
    if (active) {
      cycleStartedAt = Date.now()
      logger.debug('Replication cycle started', { replicationIdentifier })
    }
    else if (cycleStartedAt !== null) {
      logger.info('Replication cycle complete', {
        replicationIdentifier,
        durationMs: Date.now() - cycleStartedAt,
      })
      cycleStartedAt = null
    }
  })

  return replicationState
}

/**
 * Cancels a replication state and cleans up resources.
 *
 * @param replicationState - The replication state to cancel
 * @param logger - Optional logger for the cancel checkpoint
 */
export async function cancelReplication(
  replicationState: RxReplicationStateType,
  logger: DBLogger = noopLogger,
): Promise<void> {
  if (replicationState && typeof replicationState.cancel === 'function') {
    await replicationState.cancel()
    logger.info('Replication cancelled', { replicationIdentifier: replicationState.replicationIdentifier })
  }
}

/**
 * Triggers a manual sync cycle for a replication state.
 *
 * @param replicationState - The replication state to sync
 */
export async function resyncReplication(
  replicationState: RxReplicationStateType,
): Promise<void> {
  if (replicationState && typeof replicationState.reSync === 'function') {
    await replicationState.reSync()
  }
}

/**
 * RxDB Replication Helper
 *
 * Thin wrapper over rxdb/plugins/replication for creating replication states.
 * App provides push/pull handlers that connect to their backend (e.g., collab adapter).
 */

import { replicateRxCollection } from 'rxdb/plugins/replication'

import type {
  ReplicationConfig,
  RxReplicationStateType,
  DBLogger,
} from './types'

/**
 * Default no-op logger for when none is provided.
 */
const noopLogger: DBLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

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
 * replication.error$.subscribe((error) => {
 *   console.error('Sync error:', error)
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
  config: ReplicationConfig<T>
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
        logger.debug('Pushing documents', { count: (docs as unknown[]).length })
        try {
          await push.handler(docs)
          logger.debug('Push complete', { count: (docs as unknown[]).length })
        } catch (error) {
          logger.error('Push failed', { error })
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
        batchSize: number
      ) => {
        logger.debug('Pulling documents', { checkpoint: lastCheckpoint, batchSize })
        try {
          const result = await pull.handler(lastCheckpoint, batchSize)
          logger.debug('Pull complete', { count: result.documents.length })
          return result
        } catch (error) {
          logger.error('Pull failed', { error })
          throw error
        }
      },
    }
  }

  const replicationState = replicateRxCollection(replicationOptions)

  // Log replication events
  replicationState.error$.subscribe((error: Error) => {
    logger.error('Replication error', { error: error.message })
  })

  replicationState.active$.subscribe((active: boolean) => {
    logger.debug('Replication active state changed', { active })
  })

  return replicationState
}

/**
 * Cancels a replication state and cleans up resources.
 *
 * @param replicationState - The replication state to cancel
 */
export async function cancelReplication(
  replicationState: RxReplicationStateType
): Promise<void> {
  if (replicationState && typeof replicationState.cancel === 'function') {
    await replicationState.cancel()
  }
}

/**
 * Triggers a manual sync cycle for a replication state.
 *
 * @param replicationState - The replication state to sync
 */
export async function resyncReplication(
  replicationState: RxReplicationStateType
): Promise<void> {
  if (replicationState && typeof replicationState.reSync === 'function') {
    await replicationState.reSync()
  }
}

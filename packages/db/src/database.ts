/**
 * RxDB Database Factory
 *
 * Creates a configured RxDB database instance with collections.
 * App provides storage adapter (e.g., getRxStorageSQLite()).
 */

import type {
  DatabaseConfig,
  DBLogger,
  RxDatabaseType,
} from './types'
import { addRxPlugin, createRxDatabase } from 'rxdb'

import { RxDBMigrationPlugin } from 'rxdb/plugins/migration-schema'
import { describeError, noopLogger } from './logger'

// Add migration plugin for schema upgrades
addRxPlugin(RxDBMigrationPlugin)

/**
 * Creates an RxDB database instance with configured collections.
 *
 * @param config - Database configuration
 * @returns Promise resolving to the RxDB database instance
 *
 * @example
 * ```typescript
 * import { createDatabase } from '@mongrov/db'
 * import { getRxStorageSQLite } from 'rxdb-premium/plugins/storage-sqlite'
 *
 * const db = await createDatabase({
 *   name: 'myapp',
 *   storage: getRxStorageSQLite(),
 *   collections: [
 *     {
 *       name: 'messages',
 *       schema: messageSchema,
 *       migrationStrategies: {
 *         1: (oldDoc) => ({ ...oldDoc, newField: 'default' })
 *       }
 *     }
 *   ],
 *   logger: console,
 * })
 * ```
 */
export async function createDatabase(config: DatabaseConfig): Promise<RxDatabaseType> {
  const {
    name,
    storage,
    collections,
    logger = noopLogger,
    multiInstance = false,
    ignoreDuplicate = true,
  } = config

  const startedAt = Date.now()
  logger.info('Creating database', { name, collectionCount: collections.length })

  let stage: 'open' | 'collections' = 'open'
  try {
    const db = await createRxDatabase({
      name,
      storage,
      multiInstance,
      ignoreDuplicate,
    })

    logger.debug('Database created', { name })

    // Add collections (runs schema migrations)
    if (collections.length > 0) {
      stage = 'collections'
      await db.addCollections(buildCollectionConfigs(collections))
      logger.info('Collections added', {
        names: collections.map(c => c.name),
        durationMs: Date.now() - startedAt,
      })
    }

    return db
  }
  catch (error) {
    logger.error('Database open failed', { name, stage, error: describeError(error) })
    throw error
  }
}

function buildCollectionConfigs(collections: DatabaseConfig['collections']): Record<string, any> {
  const collectionConfigs: Record<string, any> = {}
  for (const col of collections) {
    collectionConfigs[col.name] = {
      schema: col.schema,
      ...(col.migrationStrategies && { migrationStrategies: col.migrationStrategies }),
    }
  }
  return collectionConfigs
}

/**
 * Destroys an RxDB database instance and cleans up resources.
 *
 * @param db - The database instance to destroy
 * @param logger - Optional logger for the destroy checkpoint and failure
 */
export async function destroyDatabase(
  db: RxDatabaseType,
  logger: DBLogger = noopLogger,
): Promise<void> {
  if (db && typeof db.destroy === 'function') {
    try {
      await db.destroy()
      logger.info('Database destroyed', { name: db.name })
    }
    catch (error) {
      logger.error('Database destroy failed', { name: db.name, error: describeError(error) })
      throw error
    }
  }
}

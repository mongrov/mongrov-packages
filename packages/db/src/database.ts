/**
 * RxDB Database Factory
 *
 * Creates a configured RxDB database instance with collections.
 * App provides storage adapter (e.g., getRxStorageSQLite()).
 */

import { createRxDatabase, addRxPlugin } from 'rxdb'
import { RxDBMigrationPlugin } from 'rxdb/plugins/migration-schema'

import type {
  DatabaseConfig,
  RxDatabaseType,
  DBLogger,
} from './types'

// Add migration plugin for schema upgrades
addRxPlugin(RxDBMigrationPlugin)

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

  logger.info('Creating database', { name, collectionCount: collections.length })

  // Create the database
  const db = await createRxDatabase({
    name,
    storage,
    multiInstance,
    ignoreDuplicate,
  })

  logger.debug('Database created', { name })

  // Add collections
  if (collections.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const collectionConfigs: Record<string, any> = {}

    for (const col of collections) {
      collectionConfigs[col.name] = {
        schema: col.schema,
        ...(col.migrationStrategies && { migrationStrategies: col.migrationStrategies }),
      }
    }

    await db.addCollections(collectionConfigs)
    logger.info('Collections added', { names: collections.map(c => c.name) })
  }

  return db
}

/**
 * Destroys an RxDB database instance and cleans up resources.
 *
 * @param db - The database instance to destroy
 */
export async function destroyDatabase(db: RxDatabaseType): Promise<void> {
  if (db && typeof db.destroy === 'function') {
    await db.destroy()
  }
}

/**
 * Tests for createDatabase factory
 */

import { createDatabase, destroyDatabase } from '../database'
import type { DatabaseConfig, CollectionConfig } from '../types'
import { __clearAllDatabases } from '../../__mocks__/rxdb'

// Sample schema for testing
const messageSchema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    content: { type: 'string' },
    createdAt: { type: 'number' },
  },
  required: ['id', 'content'],
}

const userSchema = {
  version: 0,
  primaryKey: 'id',
  type: 'object',
  properties: {
    id: { type: 'string', maxLength: 100 },
    name: { type: 'string' },
    email: { type: 'string' },
  },
  required: ['id', 'name'],
}

describe('createDatabase', () => {
  afterEach(async () => {
    __clearAllDatabases()
  })

  it('should create a database with the given name', async () => {
    const config: DatabaseConfig = {
      name: 'test-db',
      storage: {},
      collections: [],
    }

    const db = await createDatabase(config)

    expect(db).toBeDefined()
    expect(db.name).toBe('test-db')
  })

  it('should add collections to the database', async () => {
    const collections: CollectionConfig[] = [
      { name: 'messages', schema: messageSchema },
      { name: 'users', schema: userSchema },
    ]

    const config: DatabaseConfig = {
      name: 'test-db-with-collections',
      storage: {},
      collections,
    }

    const db = await createDatabase(config)

    expect(db.messages).toBeDefined()
    expect(db.users).toBeDefined()
  })

  it('should work with empty collections array', async () => {
    const config: DatabaseConfig = {
      name: 'empty-db',
      storage: {},
      collections: [],
    }

    const db = await createDatabase(config)

    expect(db).toBeDefined()
    expect(db.name).toBe('empty-db')
  })

  it('should use provided multiInstance setting', async () => {
    const config: DatabaseConfig = {
      name: 'multi-instance-db',
      storage: {},
      collections: [],
      multiInstance: true,
    }

    const db = await createDatabase(config)

    // Database should be created successfully with multiInstance
    expect(db).toBeDefined()
  })

  it('should handle migration strategies in collection config', async () => {
    const schemaV1 = {
      ...messageSchema,
      version: 1,
      properties: {
        ...messageSchema.properties,
        newField: { type: 'string' },
      },
    }

    const collections: CollectionConfig[] = [
      {
        name: 'messages',
        schema: schemaV1,
        migrationStrategies: {
          1: (oldDoc) => ({ ...oldDoc, newField: 'default' }),
        },
      },
    ]

    const config: DatabaseConfig = {
      name: 'migration-db',
      storage: {},
      collections,
    }

    const db = await createDatabase(config)

    expect(db.messages).toBeDefined()
  })

  it('should call logger methods during database creation', async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    const config: DatabaseConfig = {
      name: 'logged-db',
      storage: {},
      collections: [{ name: 'messages', schema: messageSchema }],
      logger,
    }

    await createDatabase(config)

    expect(logger.info).toHaveBeenCalledWith(
      'Creating database',
      expect.objectContaining({ name: 'logged-db', collectionCount: 1 })
    )
    expect(logger.debug).toHaveBeenCalledWith(
      'Database created',
      expect.objectContaining({ name: 'logged-db' })
    )
    expect(logger.info).toHaveBeenCalledWith(
      'Collections added',
      expect.objectContaining({ names: ['messages'] })
    )
  })

  it('should not log when no logger is provided', async () => {
    // This test ensures the noop logger doesn't throw
    const config: DatabaseConfig = {
      name: 'silent-db',
      storage: {},
      collections: [{ name: 'messages', schema: messageSchema }],
    }

    // Should not throw
    const db = await createDatabase(config)
    expect(db).toBeDefined()
  })
})

describe('destroyDatabase', () => {
  afterEach(async () => {
    __clearAllDatabases()
  })

  it('should destroy the database', async () => {
    const config: DatabaseConfig = {
      name: 'destroy-test-db',
      storage: {},
      collections: [],
    }

    const db = await createDatabase(config)

    // Should not throw
    await destroyDatabase(db)
  })

  it('should handle null/undefined database gracefully', async () => {
    // Should not throw
    await destroyDatabase(null)
    await destroyDatabase(undefined)
  })

  it('should handle database without destroy method', async () => {
    const fakeDb = { name: 'fake' }

    // Should not throw
    await destroyDatabase(fakeDb)
  })
})

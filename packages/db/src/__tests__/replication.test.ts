/**
 * Tests for replication helpers
 */

import {
  createReplicationState,
  cancelReplication,
  resyncReplication,
} from '../replication'
import type { ReplicationConfig } from '../types'
import {
  __getReplicationState,
  __clearAllReplications,
} from '../../__mocks__/rxdb/plugins/replication'

// Mock collection
const mockCollection = {
  name: 'messages',
  find: jest.fn(),
  insert: jest.fn(),
}

describe('createReplicationState', () => {
  afterEach(() => {
    __clearAllReplications()
    jest.clearAllMocks()
  })

  it('should create a replication state with given identifier', () => {
    const config: ReplicationConfig = {
      replicationIdentifier: 'test-replication',
      collection: mockCollection,
    }

    const state = createReplicationState(config)

    expect(state).toBeDefined()
    expect(state.replicationIdentifier).toBe('test-replication')
  })

  it('should create replication with push handler', async () => {
    const pushHandler = jest.fn().mockResolvedValue(undefined)

    const config: ReplicationConfig = {
      replicationIdentifier: 'push-test',
      collection: mockCollection,
      push: {
        handler: pushHandler,
        batchSize: 50,
      },
    }

    const state = createReplicationState(config)

    // Get the mock state to test push
    const mockState = __getReplicationState('push-test')
    expect(mockState).toBeDefined()
    expect(mockState?._pushHandler).toBeDefined()

    // Trigger push
    const docs = [{ id: '1', content: 'test' }]
    await mockState?._triggerPush(docs)

    expect(pushHandler).toHaveBeenCalledWith(docs)
  })

  it('should create replication with pull handler', async () => {
    const pullHandler = jest.fn().mockResolvedValue({
      documents: [{ id: '1', content: 'pulled' }],
      checkpoint: { ts: 123 },
    })

    const config: ReplicationConfig = {
      replicationIdentifier: 'pull-test',
      collection: mockCollection,
      pull: {
        handler: pullHandler,
        batchSize: 25,
      },
    }

    createReplicationState(config)

    const mockState = __getReplicationState('pull-test')
    expect(mockState?._pullHandler).toBeDefined()

    // Trigger pull
    const result = await mockState?._triggerPull(null, 25)

    expect(pullHandler).toHaveBeenCalledWith(null, 25)
    expect(result?.documents).toHaveLength(1)
    expect(result?.checkpoint).toEqual({ ts: 123 })
  })

  it('should create replication with both push and pull', async () => {
    const pushHandler = jest.fn().mockResolvedValue(undefined)
    const pullHandler = jest.fn().mockResolvedValue({
      documents: [],
      checkpoint: null,
    })

    const config: ReplicationConfig = {
      replicationIdentifier: 'bidirectional-test',
      collection: mockCollection,
      push: { handler: pushHandler },
      pull: { handler: pullHandler },
    }

    createReplicationState(config)

    const mockState = __getReplicationState('bidirectional-test')
    expect(mockState?._pushHandler).toBeDefined()
    expect(mockState?._pullHandler).toBeDefined()
  })

  it('should start with autoStart true by default', () => {
    const config: ReplicationConfig = {
      replicationIdentifier: 'autostart-test',
      collection: mockCollection,
    }

    const state = createReplicationState(config)
    let isActive = false
    state.active$.subscribe((active: boolean) => {
      isActive = active
    })

    expect(isActive).toBe(true)
  })

  it('should call logger on replication creation', () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    const config: ReplicationConfig = {
      replicationIdentifier: 'logged-replication',
      collection: mockCollection,
      push: { handler: jest.fn() },
      pull: { handler: jest.fn() },
      live: true,
      logger,
    }

    createReplicationState(config)

    expect(logger.info).toHaveBeenCalledWith(
      'Creating replication state',
      expect.objectContaining({
        replicationIdentifier: 'logged-replication',
        hasPush: true,
        hasPull: true,
        live: true,
      })
    )
  })

  it('should log errors from error$ stream', () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    const config: ReplicationConfig = {
      replicationIdentifier: 'error-test',
      collection: mockCollection,
      logger,
    }

    createReplicationState(config)

    const mockState = __getReplicationState('error-test')
    const testError = new Error('Test sync error')
    mockState?._emitError(testError)

    expect(logger.error).toHaveBeenCalledWith(
      'Replication error',
      expect.objectContaining({ error: 'Test sync error' })
    )
  })
})

describe('cancelReplication', () => {
  afterEach(() => {
    __clearAllReplications()
  })

  it('should cancel a replication state', async () => {
    const config: ReplicationConfig = {
      replicationIdentifier: 'cancel-test',
      collection: mockCollection,
    }

    const state = createReplicationState(config)

    await cancelReplication(state)

    expect(state.canceled).toBe(true)
  })

  it('should handle null/undefined gracefully', async () => {
    // Should not throw
    await cancelReplication(null)
    await cancelReplication(undefined)
  })

  it('should handle state without cancel method', async () => {
    const fakeState = { replicationIdentifier: 'fake' }

    // Should not throw
    await cancelReplication(fakeState)
  })
})

describe('resyncReplication', () => {
  afterEach(() => {
    __clearAllReplications()
  })

  it('should trigger resync on a replication state', async () => {
    const config: ReplicationConfig = {
      replicationIdentifier: 'resync-test',
      collection: mockCollection,
      autoStart: false, // Start inactive
    }

    const state = createReplicationState(config)

    let wasActive = false
    state.active$.subscribe((active: boolean) => {
      wasActive = active
    })

    await resyncReplication(state)

    expect(wasActive).toBe(true)
  })

  it('should handle null/undefined gracefully', async () => {
    // Should not throw
    await resyncReplication(null)
    await resyncReplication(undefined)
  })

  it('should handle state without reSync method', async () => {
    const fakeState = { replicationIdentifier: 'fake' }

    // Should not throw
    await resyncReplication(fakeState)
  })
})

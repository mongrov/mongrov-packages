import type { LogContext, LogEntry } from '../types'
import { OfflineQueue } from '../offline-queue'

// Mock network-state module
jest.mock('../network-state', () => {
  let connected = true
  const listeners = new Set<(state: { isConnected: boolean }) => void>()
  return {
    getNetworkState: jest.fn(async () => ({
      isConnected: connected,
      type: 'wifi',
      isInternetReachable: connected,
    })),
    addNetworkStateListener: jest.fn((cb: (state: { isConnected: boolean }) => void) => {
      listeners.add(cb)
      return { remove: () => listeners.delete(cb) }
    }),
    // Test helpers
    __setConnected: (val: boolean) => { connected = val },
    __notifyListeners: () => {
      listeners.forEach(cb => cb({ isConnected: connected }))
    },
    __listeners: listeners,
  }
})

const networkMock = jest.requireMock('../network-state') as {
  getNetworkState: jest.Mock
  addNetworkStateListener: jest.Mock
  __setConnected: (val: boolean) => void
  __notifyListeners: () => void
}

function makeStorage() {
  const data: Record<string, string> = {}
  return {
    getString: jest.fn((key: string) => data[key]),
    set: jest.fn((key: string, value: string) => { data[key] = value }),
    delete: jest.fn((key: string) => { delete data[key] }),
    __data: data,
  }
}

function makeEntry(overrides: Partial<LogEntry> = {}): LogEntry {
  const context: LogContext = {
    sessionId: 'test-session',
    appVersion: '1.0.0',
    platform: 'ios',
  }
  return {
    id: `entry-${Math.random()}`,
    timestamp: new Date().toISOString(),
    level: 'info',
    message: 'test',
    context,
    ...overrides,
  }
}

describe('OfflineQueue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    networkMock.__setConnected(true)
  })

  it('should enqueue entries and persist to storage', () => {
    const storage = makeStorage()
    const sendFn = jest.fn()
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    queue.enqueue([makeEntry({ message: 'test1' })])

    expect(storage.set).toHaveBeenCalled()
    expect(queue.getQueueSize()).toBe(1)

    queue.destroy()
  })

  it('should drop oldest entries when exceeding maxSize', () => {
    const storage = makeStorage()
    const sendFn = jest.fn()
    const queue = new OfflineQueue(sendFn, { maxSize: 3, storage })

    const entries = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ id: `e${i}`, message: `msg-${i}` }))
    queue.enqueue(entries)

    expect(queue.getQueueSize()).toBe(3)

    queue.destroy()
  })

  it('should flush entries when online', async () => {
    const storage = makeStorage()
    const sendFn = jest.fn().mockResolvedValue(undefined)
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    queue.enqueue([makeEntry()])
    await queue.flush()

    expect(sendFn).toHaveBeenCalledTimes(1)
    expect(queue.getQueueSize()).toBe(0)

    queue.destroy()
  })

  it('should not flush when offline', async () => {
    networkMock.__setConnected(false)
    networkMock.getNetworkState.mockResolvedValueOnce({
      isConnected: false,
      type: 'none',
      isInternetReachable: false,
    })

    const storage = makeStorage()
    const sendFn = jest.fn()
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    queue.enqueue([makeEntry()])
    await queue.flush()

    expect(sendFn).not.toHaveBeenCalled()
    expect(queue.getQueueSize()).toBe(1)

    queue.destroy()
  })

  it('should retry with exponential backoff on send failure', async () => {
    const storage = makeStorage()
    let callCount = 0
    const sendFn = jest.fn(async () => {
      callCount++
      if (callCount < 3)
        throw new Error('network error')
    })

    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })
    queue.enqueue([makeEntry()])

    // Use fake timers for backoff delays
    jest.useFakeTimers()
    const flushPromise = queue.flush()

    // Process the retries
    for (let i = 0; i < 5; i++) {
      await Promise.resolve() // let microtasks run
      jest.advanceTimersByTime(20000)
      await Promise.resolve()
    }

    await flushPromise
    jest.useRealTimers()

    expect(sendFn).toHaveBeenCalledTimes(3)
    expect(queue.getQueueSize()).toBe(0)

    queue.destroy()
  })

  it('should keep entries in queue when all retries are exhausted', async () => {
    const storage = makeStorage()
    const sendFn = jest.fn().mockRejectedValue(new Error('always fails'))

    const queue = new OfflineQueue(sendFn, { maxSize: 500, maxRetries: 2, storage })
    queue.enqueue([makeEntry({ message: 'must survive' })])

    jest.useFakeTimers()
    const flushPromise = queue.flush()

    // Advance through both retry delays
    for (let i = 0; i < 3; i++) {
      await Promise.resolve()
      jest.advanceTimersByTime(10000)
      await Promise.resolve()
    }

    await flushPromise
    jest.useRealTimers()

    // Entries should still be in queue after exhaustion
    expect(queue.getQueueSize()).toBe(1)
    expect(sendFn).toHaveBeenCalledTimes(2)

    queue.destroy()
  })

  it('should handle corrupt JSON in storage gracefully', () => {
    const storage = makeStorage()
    storage.__data['@mongrov/log-queue'] = '{not valid json'

    const sendFn = jest.fn()
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    expect(queue.getQueueSize()).toBe(0)

    queue.destroy()
  })

  it('should load persisted queue from storage on creation', () => {
    const storage = makeStorage()
    const entry = makeEntry({ message: 'persisted' })
    storage.__data['@mongrov/log-queue'] = JSON.stringify([entry])

    const sendFn = jest.fn()
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    expect(queue.getQueueSize()).toBe(1)

    queue.destroy()
  })

  it('should clear storage when queue is empty after flush', async () => {
    const storage = makeStorage()
    const sendFn = jest.fn().mockResolvedValue(undefined)
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    queue.enqueue([makeEntry()])
    await queue.flush()

    expect(storage.delete).toHaveBeenCalledWith('@mongrov/log-queue')

    queue.destroy()
  })

  it('should attempt flush on network reconnect', async () => {
    const storage = makeStorage()
    const sendFn = jest.fn().mockResolvedValue(undefined)
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    queue.enqueue([makeEntry()])

    // Simulate reconnect
    networkMock.__setConnected(true)
    networkMock.__notifyListeners()

    // Give the async flush a tick to run
    await new Promise(r => setTimeout(r, 10))

    expect(sendFn).toHaveBeenCalled()

    queue.destroy()
  })

  it('should clean up network listener on destroy', () => {
    const storage = makeStorage()
    const sendFn = jest.fn()
    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })

    expect(networkMock.addNetworkStateListener).toHaveBeenCalled()
    queue.destroy()
    // After destroy, the listener should be removed (no crash on further notifications)
    networkMock.__notifyListeners()
  })

  /**
   * 2026-09-26 review, finding 8 (P2).
   *
   * `flush` snapshotted the queue, awaited delivery, then dropped
   * `batch.length` entries from the CURRENT queue. While the send was
   * pending, `enqueue` could trim the head to honour `maxSize`, so the queue
   * no longer started with that batch — and slicing by its original length
   * removed newly queued entries that were never sent.
   */
  it('keeps an entry enqueued mid-send when the queue was trimmed under it', async () => {
    const storage = makeStorage()
    let releaseSend: (() => void) | undefined
    const sendFn = jest.fn(() => new Promise<void>((resolve) => {
      releaseSend = resolve
    }))

    // Capacity two, and full.
    const queue = new OfflineQueue(sendFn, { maxSize: 2, storage })
    const a = makeEntry({ message: 'a' })
    const b = makeEntry({ message: 'b' })
    queue.enqueue([a, b])

    const flushing = queue.flush()
    await Promise.resolve()
    expect(sendFn).toHaveBeenCalledTimes(1)

    // A new entry arrives mid-send. At capacity, this trims the head, so the
    // queue is now [b, c] — it no longer starts with the in-flight batch.
    const c = makeEntry({ message: 'c' })
    queue.enqueue([c])

    releaseSend?.()
    await flushing

    // [a, b] were delivered. `c` was not, so `c` must survive.
    expect(sendFn.mock.calls[0]![0]).toEqual([a, b])
    expect(queue.getQueueSize()).toBe(1)
    const persisted = JSON.parse(storage.__data['@mongrov/log-queue']!) as LogEntry[]
    expect(persisted.map(e => e.message)).toEqual(['c'])
  })

  /**
   * The control for the test above, not a second regression test: with no
   * trimming (maxSize 500) identity removal and the old length-slicing agree,
   * and it passes either way. It is here to show the fix does not change
   * behaviour in the ordinary case — only in the one where the queue moved
   * under the in-flight batch.
   */
  it('removes exactly the delivered entries, leaving later ones in order', async () => {
    const storage = makeStorage()
    let releaseSend: (() => void) | undefined
    const sendFn = jest.fn(() => new Promise<void>((resolve) => {
      releaseSend = resolve
    }))

    const queue = new OfflineQueue(sendFn, { maxSize: 500, storage })
    const a = makeEntry({ message: 'a' })
    const b = makeEntry({ message: 'b' })
    queue.enqueue([a, b])

    const flushing = queue.flush()
    await Promise.resolve()

    const c = makeEntry({ message: 'c' })
    const d = makeEntry({ message: 'd' })
    queue.enqueue([c, d])

    releaseSend?.()
    await flushing

    expect(queue.getQueueSize()).toBe(2)
    const persisted = JSON.parse(storage.__data['@mongrov/log-queue']!) as LogEntry[]
    expect(persisted.map(e => e.message)).toEqual(['c', 'd'])
  })
})

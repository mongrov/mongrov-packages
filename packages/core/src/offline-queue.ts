import type { LogEntry } from './types'
import { addNetworkStateListener, getNetworkState } from './network-state'

const QUEUE_KEY = '@mongrov/log-queue'
const DEFAULT_MAX_SIZE = 500
const DEFAULT_MAX_RETRIES = 5
const BASE_DELAY_MS = 1000

interface MMKVStorage {
  getString(key: string): string | undefined
  set(key: string, value: string): void
  delete(key: string): void
}

function getMMKV(): MMKVStorage {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MMKV } = require('react-native-mmkv')
    return new MMKV()
  } catch {
    throw new Error(
      '@mongrov/core OfflineQueue requires react-native-mmkv as a peer dependency'
    )
  }
}

export class OfflineQueue {
  private queue: LogEntry[] = []
  private readonly maxSize: number
  private readonly maxRetries: number
  private readonly sendFn: (entries: LogEntry[]) => Promise<void>
  private storage: MMKVStorage
  private networkSubscription: { remove: () => void } | null = null
  private flushing = false

  constructor(
    sendFn: (entries: LogEntry[]) => Promise<void>,
    options?: {
      maxSize?: number
      maxRetries?: number
      storage?: MMKVStorage
    }
  ) {
    this.sendFn = sendFn
    this.maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES
    this.storage = options?.storage ?? getMMKV()
    this.loadFromStorage()
    this.listenForConnectivity()
  }

  enqueue(entries: LogEntry[]): void {
    this.queue.push(...entries)

    // Drop oldest entries if over max size (FIFO)
    if (this.queue.length > this.maxSize) {
      this.queue = this.queue.slice(this.queue.length - this.maxSize)
    }

    this.saveToStorage()
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return

    const networkState = await getNetworkState()
    if (!networkState.isConnected) return

    this.flushing = true

    try {
      // Take a snapshot of entries to send
      const batch = [...this.queue]
      await this.sendWithRetry(batch)

      // On success, remove sent entries (preserving any enqueued during send)
      this.queue = this.queue.slice(batch.length)
      this.saveToStorage()
    } catch {
      // Retries exhausted — entries stay in queue for next flush attempt
      this.saveToStorage()
    } finally {
      this.flushing = false
    }
  }

  getQueueSize(): number {
    return this.queue.length
  }

  destroy(): void {
    if (this.networkSubscription) {
      this.networkSubscription.remove()
      this.networkSubscription = null
    }
  }

  private async sendWithRetry(entries: LogEntry[]): Promise<void> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        await this.sendFn(entries)
        return
      } catch (error) {
        if (attempt < this.maxRetries - 1) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt)
          await new Promise<void>((resolve) => setTimeout(resolve, delay))
        } else {
          // All retries exhausted — throw so caller knows entries were NOT sent
          throw error
        }
      }
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = this.storage.getString(QUEUE_KEY)
      if (raw) {
        const parsed: unknown = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.queue = parsed as LogEntry[]
        }
      }
    } catch {
      this.queue = []
    }
  }

  private saveToStorage(): void {
    try {
      if (this.queue.length === 0) {
        this.storage.delete(QUEUE_KEY)
      } else {
        this.storage.set(QUEUE_KEY, JSON.stringify(this.queue))
      }
    } catch {
      // Storage failures are non-critical
    }
  }

  private listenForConnectivity(): void {
    this.networkSubscription = addNetworkStateListener((state) => {
      if (state.isConnected) {
        this.flush().catch(() => {})
      }
    })
  }
}

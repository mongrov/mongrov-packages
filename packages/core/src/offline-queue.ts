import type { InternalLogger } from './internal-log'
import type { LogEntry } from './types'
import { devConsoleLogger, FailureGate } from './internal-log'
import { addNetworkStateListener, getNetworkState } from './network-state'

const QUEUE_KEY = '@mongrov/log-queue'
const DEFAULT_MAX_SIZE = 500
const DEFAULT_MAX_RETRIES = 5
const BASE_DELAY_MS = 1000

interface MMKVStorage {
  getString: (key: string) => string | undefined
  set: (key: string, value: string) => void
  delete: (key: string) => void
}

function getMMKV(): MMKVStorage {
  try {
    const { MMKV } = require('react-native-mmkv')
    return new MMKV()
  }
  catch {
    throw new Error(
      '@mongrov/core OfflineQueue requires react-native-mmkv as a peer dependency',
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
  private readonly log: InternalLogger
  // Entries trimmed off the head since the last report.
  private overflowDropped = 0
  private readonly storageFailures = new FailureGate()

  constructor(
    sendFn: (entries: LogEntry[]) => Promise<void>,
    options?: {
      maxSize?: number
      maxRetries?: number
      storage?: MMKVStorage
      /** Receives the queue's own failures; dev console when omitted. */
      logger?: InternalLogger
    },
  ) {
    this.log = options?.logger ?? devConsoleLogger()
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
      const dropped = this.queue.length - this.maxSize
      this.queue = this.queue.slice(dropped)
      // Once per overflow run; the total is reported when the queue drains.
      if (this.overflowDropped === 0)
        this.log.warn('[OfflineQueue] full; dropping oldest entries', { maxSize: this.maxSize })
      this.overflowDropped += dropped
    }

    this.saveToStorage()
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0)
      return

    let networkState
    try {
      networkState = await getNetworkState()
    }
    catch (error) {
      // No reading (expo-network missing or failing): keep the entries for
      // the next attempt rather than throwing out of a background flush.
      this.log.warn('[OfflineQueue] network state unavailable; flush skipped', { error: String(error) })
      return
    }
    if (!networkState.isConnected)
      return

    this.flushing = true
    const batch = [...this.queue]
    const startedAt = Date.now()

    try {
      await this.sendWithRetry(batch)

      // Remove the delivered entries BY ID, not by slicing off `batch.length`
      // from the head.
      //
      // The queue can be rewritten while the send is pending: `enqueue` trims
      // the head to honour `maxSize`, so the queue no longer starts with this
      // batch. Slicing by the batch's original length then removed entries
      // that were never sent. Measured at capacity two: send [a, b], enqueue
      // `c` mid-send, complete — [a, b] were delivered, but the queue ended up
      // EMPTY instead of holding `c` (2026-09-26 review, finding 8).
      //
      // Identity is exact regardless of how the queue was reordered or
      // trimmed underneath: entries that were delivered go, entries that were
      // not stay.
      const deliveredIds = new Set(batch.map(entry => entry.id))
      this.queue = this.queue.filter(entry => !deliveredIds.has(entry.id))
      this.saveToStorage()
      this.log.info('[OfflineQueue] flushed', {
        sent: batch.length,
        remaining: this.queue.length,
        droppedOnOverflow: this.overflowDropped,
        durationMs: Date.now() - startedAt,
      })
      this.overflowDropped = 0
    }
    catch (error) {
      // Retries exhausted — entries stay in queue for next flush attempt
      this.log.warn('[OfflineQueue] flush failed; entries kept for next attempt', {
        error: String(error),
        attempts: this.maxRetries,
        queued: this.queue.length,
      })
      this.saveToStorage()
    }
    finally {
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
      }
      catch (error) {
        if (attempt < this.maxRetries - 1) {
          const delay = BASE_DELAY_MS * 2 ** attempt
          await new Promise<void>(resolve => setTimeout(resolve, delay))
        }
        else {
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
    }
    catch (error) {
      // A corrupt saved queue is discarded: those entries are lost.
      this.log.warn('[OfflineQueue] saved queue unreadable; discarded', { error: String(error) })
      this.queue = []
    }
  }

  private saveToStorage(): void {
    try {
      if (this.queue.length === 0) {
        this.storage.delete(QUEUE_KEY)
      }
      else {
        this.storage.set(QUEUE_KEY, JSON.stringify(this.queue))
      }
      const failed = this.storageFailures.recover()
      if (failed > 0)
        this.log.info('[OfflineQueue] storage writes recovered', { failedWrites: failed })
    }
    catch (error) {
      // Non-critical while the app runs (the queue is in memory), but the
      // queue will not survive a restart. Once per run of failures.
      if (this.storageFailures.fail())
        this.log.warn('[OfflineQueue] persist failed', { error: String(error) })
    }
  }

  private listenForConnectivity(): void {
    this.networkSubscription = addNetworkStateListener((state) => {
      if (state.isConnected) {
        this.flush().catch((error) => {
          this.log.error('[OfflineQueue] flush on reconnect threw', { error: String(error) })
        })
      }
    })
  }
}

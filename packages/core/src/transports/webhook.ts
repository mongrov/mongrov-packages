import type { InternalLogger } from '../internal-log'
import type { LogEntry, LogTransport, WebhookConfig } from '../types'
import { devConsoleLogger, FailureGate } from '../internal-log'
import { OfflineQueue } from '../offline-queue'

export class WebhookTransport implements LogTransport {
  readonly name = 'webhook'

  private readonly config: Required<
    Pick<WebhookConfig, 'url' | 'batchSize' | 'batchIntervalMs' | 'maxRetries'>
  >
  & Pick<WebhookConfig, 'headers' | 'formatPayload'>

  private batch: LogEntry[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private offlineQueue: OfflineQueue
  private flushing = false
  private readonly log: InternalLogger
  // A 4xx usually means bad auth or a bad URL: every batch drops until it
  // is fixed. Reported once per run, with the total dropped at its end.
  private readonly rejections = new FailureGate()
  private droppedEntries = 0
  private readonly postFailures = new FailureGate()

  /**
   * `logger` receives this transport's own failures. `createLogger` passes
   * one that skips this transport (a report about a failing webhook must not
   * be posted to that webhook); standalone use falls back to the dev console.
   */
  constructor(config: WebhookConfig, logger?: InternalLogger) {
    this.log = logger ?? devConsoleLogger()
    this.config = {
      url: config.url,
      batchSize: config.batchSize ?? 10,
      batchIntervalMs: config.batchIntervalMs ?? 5000,
      maxRetries: config.maxRetries ?? 3,
      headers: config.headers,
      formatPayload: config.formatPayload,
    }

    this.offlineQueue = new OfflineQueue(
      entries => this.postEntries(entries),
      { maxRetries: this.config.maxRetries, logger: this.log },
    )

    this.startTimer()
  }

  async send(entries: LogEntry[]): Promise<void> {
    this.batch.push(...entries)

    if (this.batch.length >= this.config.batchSize) {
      await this.flushBatch()
    }
  }

  async flush(): Promise<void> {
    await this.flushBatch()
    await this.offlineQueue.flush()
  }

  async destroy(): Promise<void> {
    this.stopTimer()
    await this.flushBatch()
    await this.offlineQueue.flush()
    this.offlineQueue.destroy()
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      if (this.batch.length > 0) {
        this.flushBatch().catch((error) => {
          this.log.error('[WebhookTransport] timed flush threw', { error: String(error) })
        })
      }
    }, this.config.batchIntervalMs)
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.flushing || this.batch.length === 0)
      return

    this.flushing = true
    const entries = [...this.batch]
    this.batch = []

    try {
      await this.postEntries(entries)
      const failed = this.postFailures.recover()
      if (failed > 0)
        this.log.info('[WebhookTransport] posts recovered', { failedPosts: failed })
    }
    catch (error) {
      // Delegate to offline queue for retry — every failure mode here has the
      // same remedy, and the queue is what carries the entries forward.
      if (this.postFailures.fail()) {
        this.log.warn('[WebhookTransport] post failed; queued for retry', {
          error: String(error),
          entries: entries.length,
        })
      }
      this.offlineQueue.enqueue(entries)
    }
    finally {
      this.flushing = false
    }
  }

  private async postEntries(entries: LogEntry[]): Promise<void> {
    const payload = this.config.formatPayload
      ? this.config.formatPayload(entries)
      : { entries }

    const response = await fetch(this.config.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.config.headers,
      },
      body: JSON.stringify(payload),
    })

    if (response.status >= 400 && response.status < 500) {
      // Client error — drop entries, retrying won't help
      this.droppedEntries += entries.length
      if (this.rejections.fail()) {
        this.log.error('[WebhookTransport] rejected by server; dropping entries', {
          status: response.status,
          entries: entries.length,
        })
      }
      return
    }

    if (!response.ok) {
      // 5xx — throw to trigger offline queue retry
      throw new Error(`HTTP ${response.status}`)
    }

    const rejected = this.rejections.recover()
    if (rejected > 0) {
      this.log.warn('[WebhookTransport] accepted again after rejections', {
        rejectedBatches: rejected,
        droppedEntries: this.droppedEntries,
      })
      this.droppedEntries = 0
    }
  }
}

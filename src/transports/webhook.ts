import type { LogEntry, LogTransport, WebhookConfig } from '../types'
import { OfflineQueue } from '../offline-queue'

export class WebhookTransport implements LogTransport {
  readonly name = 'webhook'

  private readonly config: Required<
    Pick<WebhookConfig, 'url' | 'batchSize' | 'batchIntervalMs' | 'maxRetries'>
  > &
    Pick<WebhookConfig, 'headers' | 'formatPayload'>

  private batch: LogEntry[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private offlineQueue: OfflineQueue
  private flushing = false

  constructor(config: WebhookConfig) {
    this.config = {
      url: config.url,
      batchSize: config.batchSize ?? 10,
      batchIntervalMs: config.batchIntervalMs ?? 5000,
      maxRetries: config.maxRetries ?? 3,
      headers: config.headers,
      formatPayload: config.formatPayload,
    }

    this.offlineQueue = new OfflineQueue(
      (entries) => this.postEntries(entries),
      { maxRetries: this.config.maxRetries }
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
        this.flushBatch().catch(() => {})
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
    if (this.flushing || this.batch.length === 0) return

    this.flushing = true
    const entries = [...this.batch]
    this.batch = []

    try {
      await this.postEntries(entries)
    } catch (error) {
      // Delegate to offline queue for retry
      this.offlineQueue.enqueue(entries)
    } finally {
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
      console.warn(
        `[WebhookTransport] HTTP ${response.status}: dropping ${entries.length} entries`
      )
      return
    }

    if (!response.ok) {
      // 5xx — throw to trigger offline queue retry
      throw new Error(`HTTP ${response.status}`)
    }
  }
}

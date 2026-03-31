import type { LogEntry, LogFilter, LogLevel, LogTransport } from '../types'

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
}

export class RingBufferTransport implements LogTransport {
  readonly name = 'ring-buffer'

  private buffer: (LogEntry | null)[]
  private head = 0
  private count = 0
  private readonly maxSize: number

  constructor(maxSize = 1000) {
    this.maxSize = maxSize
    this.buffer = new Array(maxSize).fill(null)
  }

  async send(entries: LogEntry[]): Promise<void> {
    for (const entry of entries) {
      this.buffer[this.head] = entry
      this.head = (this.head + 1) % this.maxSize
      if (this.count < this.maxSize) {
        this.count++
      }
    }
  }

  getEntries(filter?: LogFilter): LogEntry[] {
    const entries: LogEntry[] = []

    // Read from newest to oldest
    for (let i = 0; i < this.count; i++) {
      const index = (this.head - 1 - i + this.maxSize) % this.maxSize
      const entry = this.buffer[index]
      if (entry) {
        entries.push(entry)
      }
    }

    return this.applyFilter(entries, filter)
  }

  clear(): void {
    this.buffer = new Array(this.maxSize).fill(null)
    this.head = 0
    this.count = 0
  }

  toJSON(): string {
    return JSON.stringify(this.getEntries())
  }

  private applyFilter(entries: LogEntry[], filter?: LogFilter): LogEntry[] {
    if (!filter) return entries

    let result = entries

    if (filter.level) {
      const minLevel = LEVEL_ORDER[filter.level]
      result = result.filter((e) => LEVEL_ORDER[e.level] >= minLevel)
    }

    if (filter.since) {
      const sinceTime = filter.since.getTime()
      result = result.filter((e) => new Date(e.timestamp).getTime() >= sinceTime)
    }

    if (filter.search) {
      const search = filter.search.toLowerCase()
      result = result.filter((e) => e.message.toLowerCase().includes(search))
    }

    if (filter.limit && filter.limit > 0) {
      result = result.slice(0, filter.limit)
    }

    return result
  }
}

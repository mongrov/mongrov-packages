/**
 * How core's own parts (transports, offline queue, network state) report
 * their failures. `createLogger` hands each part a logger that writes to every
 * transport EXCEPT the one reporting — so a failing file write lands in the
 * ring buffer instead of failing again and reporting again.
 */
export interface InternalLogger {
  debug: (message: string, data?: Record<string, unknown>) => void
  info: (message: string, data?: Record<string, unknown>) => void
  warn: (message: string, data?: Record<string, unknown>) => void
  error: (message: string, data?: Record<string, unknown>) => void
}

function isDev(): boolean {
  try {
    return typeof __DEV__ !== 'undefined' ? __DEV__ : false
  }
  catch {
    return false
  }
}

/**
 * Fallback for a part used on its own, outside `createLogger`: failures to
 * the dev console only (release has no reader for console output).
 */
export function devConsoleLogger(): InternalLogger {
  const out = (fn: (...args: unknown[]) => void) =>
    (message: string, data?: Record<string, unknown>) => {
      if (isDev())
        fn(message, data ?? '')
    }
  const none = () => {}
  return {
    debug: none,
    info: none,
    warn: out(console.warn),
    error: out(console.error),
  }
}

/**
 * Collapses a run of identical failures into one report at its start and one
 * at its end. A dead disk or a webhook answering 401 fails on every batch;
 * reporting each would flood the ring buffer with the same line.
 */
export class FailureGate {
  private failures = 0

  /** True on the first failure of a run — the one worth reporting. */
  fail(): boolean {
    this.failures++
    return this.failures === 1
  }

  /** Failures in the run that just ended (0 if none). */
  recover(): number {
    const n = this.failures
    this.failures = 0
    return n
  }

  get failing(): boolean {
    return this.failures > 0
  }
}

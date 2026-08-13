import type { Clock } from '../types'

/** Pinnable clock for throttle tests. Advance via `set(date)`. */
export function createFakeClock(initial: Date | string): Clock & {
  set: (t: Date | string) => void
  advance: (ms: number) => void
} {
  let now = new Date(initial)
  const clock = (() => new Date(now)) as Clock & {
    set: (t: Date | string) => void
    advance: (ms: number) => void
  }
  clock.set = (t) => {
    now = new Date(t)
  }
  clock.advance = (ms) => {
    now = new Date(now.getTime() + ms)
  }
  return clock
}

/** `fnv1a64`: the audit's result digest, checked against a BigInt reference. */

import { describe, expect, it } from 'vitest'
import { fnv1a64 } from '../digest'

function reference(text: string): string {
  let h = 0xCBF29CE484222325n
  for (const b of new TextEncoder().encode(text)) {
    h ^= BigInt(b)
    h = (h * 0x100000001B3n) & 0xFFFFFFFFFFFFFFFFn
  }
  return h.toString(16).padStart(16, '0')
}

describe('fnv1a64', () => {
  it.each(['', 'a', 'foobar', 'status: ok\nwindow: 2026-11-15 to 2026-11-21', 'é漢字🙂'.repeat(40), 'x'.repeat(5000)])('matches the reference for %j', (text) => {
    expect(fnv1a64(text)).toBe(reference(text))
  })

  it('known vectors', () => {
    expect(fnv1a64('')).toBe('cbf29ce484222325')
    expect(fnv1a64('a')).toBe('af63dc4c8601ec8c')
  })
})

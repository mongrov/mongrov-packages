/**
 * FNV-1a 64-bit over UTF-8, as 16 lowercase hex chars.
 *
 * The audit's `result_digest`: enough to tell two results apart (a repeated
 * answer, a changed one) without storing what the model read. Computed with
 * 16-bit limbs rather than `BigInt`, so it runs on every JS engine a host
 * ships.
 */

const encoder = new TextEncoder()

export function fnv1a64(text: string): string {
  // offset basis 0xcbf29ce484222325, low limb first
  let h0 = 0x2325
  let h1 = 0x8422
  let h2 = 0x9CE4
  let h3 = 0xCBF2
  for (const byte of encoder.encode(text)) {
    h0 ^= byte
    // h * 0x100000001b3 = h * 0x1b3 + (h << 40), mod 2^64
    const m0 = h0 * 0x1B3
    const m1 = h1 * 0x1B3
    const m2 = h2 * 0x1B3
    const m3 = h3 * 0x1B3
    const s2 = (h0 << 8) & 0xFFFF
    const s3 = ((h0 >>> 8) | (h1 << 8)) & 0xFFFF
    let c = m0
    h0 = c & 0xFFFF
    c = m1 + (c >>> 16)
    h1 = c & 0xFFFF
    c = m2 + s2 + Math.floor(c / 0x10000)
    h2 = c & 0xFFFF
    c = m3 + s3 + Math.floor(c / 0x10000)
    h3 = c & 0xFFFF
  }
  const hex = (n: number): string => n.toString(16).padStart(4, '0')
  return `${hex(h3)}${hex(h2)}${hex(h1)}${hex(h0)}`
}

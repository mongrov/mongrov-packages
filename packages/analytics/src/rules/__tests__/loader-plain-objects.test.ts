/**
 * A parsed catalog is plain data — no Symbol-keyed metadata anywhere.
 *
 * @iarna/toml tags tables with Symbol keys. zod 3's `z.record` ignores them;
 * zod 4's rejects them, so a catalog with a nested table (`[rule.target.scales]`,
 * analytics 0.30.0) failed to load in an app on zod 4 — every rule in the
 * brand with it. This package tests on zod 3 and cannot see that directly, so
 * it asserts the property zod 4 needs instead: not one Symbol key survives.
 */

import parseString from '@iarna/toml/parse-string.js'
import { describe, expect, it } from 'vitest'
import { parseCatalog, parseTomlPlain } from '../defaults/loader'

function symbolKeys(value: unknown, path = '$'): string[] {
  if (value === null || typeof value !== 'object')
    return []
  const own = Object.getOwnPropertySymbols(value).map(s => `${path}[${String(s)}]`)
  return [...own, ...Object.entries(value).flatMap(([k, v]) => symbolKeys(v, `${path}.${k}`))]
}

const CATALOG = `
[[rule]]
id = "t"
name = "t"
metric = "hr_bpm"
window = "24h"
compare = "between"
context = "asleep"
consecutive = 3
severity = "warn"
[rule.target]
type = "phase_band"
band = "hr_asleep"
windowDays = 90
defaultLo = 48
defaultHi = 62
[rule.target.scales]
normal = 1.0
`

describe('parseCatalog returns plain data', () => {
  it('the raw TOML parse DOES carry Symbol keys — the hazard is real', () => {
    const raw = parseString('[a]\n[a.b]\nx = 1\n')
    expect(symbolKeys(raw).length).toBeGreaterThan(0)
  })

  it('what the schema is given carries no Symbol keys — zod 4 rejects them', () => {
    // The schema's OUTPUT is no evidence: zod 3 rebuilds objects without the
    // symbols whatever it was fed. This is the input zod 4 would see.
    expect(symbolKeys(parseTomlPlain('[a]\n[a.b]\nx = 1\n'))).toEqual([])
    expect(symbolKeys(parseTomlPlain(CATALOG))).toEqual([])
  })

  it('a nested table still parses to the same rule', () => {
    const [rule] = parseCatalog(CATALOG)
    expect(rule!.target).toMatchObject({ type: 'phase_band', scales: { normal: 1 } })
  })
})

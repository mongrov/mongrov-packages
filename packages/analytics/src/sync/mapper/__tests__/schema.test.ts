/**
 * Principle 60 — firmware fixture governance.
 *
 * Coverage:
 *   1. Every fixture in `./fixtures/` parses under the strict
 *      `firmwareExportSchema` (unknown keys anywhere fail).
 *   2. Key-diff gate: the key-path set of every fixture is a subset of the
 *      schema's known key-paths, and the corpus as a whole exercises the
 *      full set — an unexpected key in a new firmware fixture is a
 *      PR-blocking failure here.
 *   3. Parity: package fixture copies are byte-identical to the canonical
 *      `techspec/.specifica/fixtures/` files (skipped when the techspec
 *      tree isn't on disk, e.g. package-only CI checkouts).
 *   4. Edge-case fixtures actually exercise the mapper semantics they were
 *      authored for (empty / DST fall-back / midnight crossing).
 */

import type { FirmwareExport, MapperContext } from '../types'
import { existsSync, readdirSync, readFileSync } from 'node:fs'

import { join } from 'node:path'

import { describe, expect, it } from 'vitest'
import { mapFirmwareExport } from '../firmware'
import { FIRMWARE_EXPORT_KEY_PATHS, firmwareExportSchema } from '../schema'

const FIXTURES_DIR = join(__dirname, 'fixtures')
// mapper/__tests__ → 7 levels up → rn-apps workspace root.
const CANONICAL_DIR = join(
  __dirname,
  '../../../../../../..',
  'techspec/.specifica/fixtures',
)

const fixtureNames = readdirSync(FIXTURES_DIR)
  .filter(f => f.startsWith('firmware-') && f.endsWith('.json'))
  .sort()

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, name), 'utf-8'))
}

/**
 * Walk a JSON value collecting key-paths. Object keys join with `.`,
 * array elements flatten to `[]` — e.g. `ring.automaticMonitoringData[].metric`.
 */
function collectKeyPaths(
  value: unknown,
  prefix = '',
  out = new Set<string>(),
): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeyPaths(item, `${prefix}[]`, out)
    return out
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const path = prefix === '' ? k : `${prefix}.${k}`
      out.add(path)
      collectKeyPaths(v, path, out)
    }
  }
  return out
}

describe('firmwareExportSchema — fixture corpus (principle 60)', () => {
  it('found the expected fixture corpus', () => {
    expect(fixtureNames).toEqual([
      'firmware-8047-17-06-2026.json',
      'firmware-dst-transition.json',
      'firmware-empty.json',
      // T-13's three named fixtures.
      'firmware-hrv-full-day.json',
      'firmware-midnight-session.json',
      'firmware-stress-tense-day.json',
      'firmware-whole-degree-temp.json',
    ])
  })

  it.each(fixtureNames)('%s parses under the strict schema', (name) => {
    const parsed = firmwareExportSchema.safeParse(loadFixture(name))
    if (!parsed.success) {
      throw new Error(
        `fixture ${name} failed schema parse:\n${parsed.error.message}`,
      )
    }
  })

  it('rejects unknown keys at any depth (the CI gate)', () => {
    const base = loadFixture('firmware-empty.json') as Record<string, unknown>
    expect(
      firmwareExportSchema.safeParse({ ...base, new_fw_section: [] }).success,
    ).toBe(false)
    expect(
      firmwareExportSchema.safeParse({
        ...base,
        heartrate: [{ timestamp: '2026.06.17 03:15:00', singleHR: 68, hrZone: 2 }],
      }).success,
    ).toBe(false)
  })

  it('key-diff: every fixture key-path is known to the schema', () => {
    for (const name of fixtureNames) {
      const paths = collectKeyPaths(loadFixture(name))
      const unexpected = [...paths].filter(
        p => !FIRMWARE_EXPORT_KEY_PATHS.has(p),
      )
      // An entry here means the firmware team shipped a key the mapper does
      // not understand — update schema.ts + the mapper deliberately.
      expect(unexpected, `unexpected key-paths in ${name}`).toEqual([])
    }
  })

  it('key-diff: the corpus exercises the full schema key-path set', () => {
    const union = new Set<string>()
    for (const name of fixtureNames) {
      for (const p of collectKeyPaths(loadFixture(name))) union.add(p)
    }
    expect([...union].sort()).toEqual([...FIRMWARE_EXPORT_KEY_PATHS].sort())
  })
})

describe('fixture parity with techspec/.specifica/fixtures', () => {
  it.skipIf(!existsSync(CANONICAL_DIR)).each(fixtureNames)(
    '%s is byte-identical to the canonical copy',
    (name) => {
      const canonicalPath = join(CANONICAL_DIR, name)
      expect(existsSync(canonicalPath), `missing canonical ${name}`).toBe(true)
      const local = readFileSync(join(FIXTURES_DIR, name), 'utf-8')
      const canonical = readFileSync(canonicalPath, 'utf-8')
      expect(local).toBe(canonical)
    },
  )
})

describe('edge-case fixtures drive the mapper as authored', () => {
  const ctx: MapperContext = {
    brand: 'ziva',
    familyId: 'fam_test',
    userId: 'user_alice',
    deviceId: 'ring_8047',
    userTimezone: 'America/Los_Angeles',
  }

  function mapFixture(name: string) {
    const { $comment: _c, ...fw } = firmwareExportSchema.parse(loadFixture(name))
    return mapFirmwareExport(fw as FirmwareExport, ctx, {
      now: new Date('2026-06-17T12:00:00.000Z'),
    })
  }

  it('firmware-empty.json maps to an all-empty batch', () => {
    const batch = mapFixture('firmware-empty.json')
    for (const rows of Object.values(batch)) {
      expect(rows).toEqual([])
    }
  })

  it('firmware-dst-transition.json: one session across the repeated hour', () => {
    const batch = mapFixture('firmware-dst-transition.json')
    expect(batch.sleep_session).toHaveLength(1)
    // 3 stages — the `primary` envelope block yields no sleep_stage row.
    expect(batch.sleep_stage).toHaveLength(3)
    // Fall-back night: midnight LA 2025-11-01 is PDT (-07).
    expect(batch.sleep_session[0].night_of.toISOString()).toBe(
      '2025-11-01T07:00:00.000Z',
    )
    // Both passes of the 01:30 local wall-clock are distinct instants in
    // the same session.
    const stageTs = batch.sleep_stage.map(s => s.ts.toISOString())
    expect(stageTs).toContain('2025-11-02T08:30:00.000Z')
    expect(stageTs).toContain('2025-11-02T09:30:00.000Z')
  })

  it('firmware-midnight-session.json: one session, night_of = pre-midnight day', () => {
    const batch = mapFixture('firmware-midnight-session.json')
    expect(batch.sleep_session).toHaveLength(1)
    // 3 stages — the `primary` envelope block yields no sleep_stage row.
    expect(batch.sleep_stage).toHaveLength(3)
    expect(batch.sleep_session[0].night_of.toISOString()).toBe(
      '2026-06-17T07:00:00.000Z',
    )
  })
})

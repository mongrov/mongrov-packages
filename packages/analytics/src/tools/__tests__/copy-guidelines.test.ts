/**
 * Sprint 5 T-29 / T-31 / T-32 — user-language guardrails (Ziva #2,
 * principle 37).
 *
 * Two layers under test: the guard itself, and the fact that every shipped
 * formatter actually calls it. The second matters more — a guard nobody
 * invokes is decoration.
 */

import { describe, expect, it } from 'vitest'

import { createFakeEngine } from '../__fakes__/engine'
import { createAnalyticsTools } from '../factory'
import {
  applyPreferredLanguage,
  assertNoBanTerms,
  BANNED_MEDICAL_VOCABULARY,
  findBanTerms,
  FormatterCopyError,
  PREFERRED_LANGUAGE,
} from '../formatters'
import { formatSpO2 } from '../formatters/spo2'

describe('assertNoBanTerms', () => {
  it.each(BANNED_MEDICAL_VOCABULARY)('throws on %s', (term) => {
    expect(() => assertNoBanTerms(`Patient shows ${term} overnight.`, 'test'))
      .toThrow(FormatterCopyError)
  })

  it('is case-insensitive', () => {
    for (const variant of ['Desaturation', 'DESATURATION', 'DeSaTuRaTiOn']) {
      expect(() => assertNoBanTerms(`Two ${variant} events.`, 'test')).toThrow()
    }
  })

  it('catches inflections of a listed stem', () => {
    // Leading-boundary matching means listing `desaturation` also covers
    // plurals and participles — over-blocking is the right bias here.
    for (const word of ['desaturations', 'desaturation-like', 'hypoxias']) {
      expect(findBanTerms(`observed ${word}`).length).toBeGreaterThan(0)
    }
  })

  it('does not fire mid-word', () => {
    // A leading word boundary keeps innocuous compounds clean.
    expect(findBanTerms('the crapnea river')).toEqual([])
    expect(findBanTerms('undesaturation')).toEqual([])
  })

  it('passes grandmother-friendly copy untouched', () => {
    const good = 'Average oxygen: 96%. A couple of brief low moments during sleep.'
    expect(() => assertNoBanTerms(good, 'test')).not.toThrow()
    expect(findBanTerms(good)).toEqual([])
  })

  it('names the formatter and every term found', () => {
    try {
      assertNoBanTerms('apnea and bradycardia', 'getSleepSummary')
      throw new Error('should have thrown')
    }
    catch (err) {
      const e = err as FormatterCopyError
      expect(e.formatterName).toBe('getSleepSummary')
      expect(e.found).toEqual(expect.arrayContaining(['apnea', 'bradycardia']))
      expect(e.message).toContain('getSleepSummary')
    }
  })
})

describe('applyPreferredLanguage', () => {
  it('rewrites the longest phrase first', () => {
    // 'oxygen desaturation' must not be eaten by the 'desaturation' entry.
    expect(applyPreferredLanguage('oxygen desaturation overnight'))
      .toBe('oxygen dip overnight')
  })

  it('produces text that then passes the guard', () => {
    const rewritten = applyPreferredLanguage('2 desaturations last night')
    expect(() => assertNoBanTerms(rewritten, 'test')).not.toThrow()
    expect(rewritten).toContain('brief low moments')
  })

  it('is a convenience, not a substitute — unknown terms survive', () => {
    // Which is exactly why the guard still runs afterwards.
    const out = applyPreferredLanguage('possible ischemia')
    expect(() => assertNoBanTerms(out, 'test')).toThrow()
  })

  it('every PREFERRED_LANGUAGE value is itself clean', () => {
    for (const [from, to] of Object.entries(PREFERRED_LANGUAGE)) {
      expect(findBanTerms(to), `${from} → ${to} still banned`).toEqual([])
    }
  })
})

describe('T-31 — getSpO2 formatter copy', () => {
  const night = (over: Partial<Record<string, unknown>> = {}) => ({
    night_of: '2026-07-01',
    avg_spo2: 96,
    min_spo2: 87,
    low_moment_count: 2,
    ...over,
  }) as never

  const baseline = { p05: 93, p10: 94, p50: 96, computed_at: '2026-07-02T00:00:00Z' }

  it('says "brief low moments", never the clinical word', () => {
    const text = formatSpO2([night()], baseline, 1)
    expect(text).toContain('brief low moments')
    expect(findBanTerms(text)).toEqual([])
  })

  it('reads like a person, not a data dump', () => {
    const text = formatSpO2([night()], baseline, 1)
    expect(text).toContain('Average oxygen: 96%')
    expect(text).toContain('usual range')
    // No raw field names leaking into the model's context.
    expect(text).not.toContain('avgSpo2')
    expect(text).not.toContain('low_moment_count')
    expect(text).not.toContain('minSpo2')
  })

  it('scales the count phrasing rather than quoting a bare number', () => {
    expect(formatSpO2([night({ low_moment_count: 0 })], baseline, 1))
      .toContain('No brief low moments')
    expect(formatSpO2([night({ low_moment_count: 1 })], baseline, 1))
      .toContain('One brief low moment')
    expect(formatSpO2([night({ low_moment_count: 2 })], baseline, 1))
      .toContain('A couple of brief low moments')
    expect(formatSpO2([night({ low_moment_count: 9 })], baseline, 1))
      .toContain('Several brief low moments')
  })

  it('declines to imply a range it does not have', () => {
    // Below 20 days there is no baseline; inventing "typically 94-98%"
    // would be a fabricated reference range.
    const text = formatSpO2([night()], null, 1)
    expect(text).toContain('Still learning your usual range')
    expect(text).not.toContain('typically')
  })

  it('phrases an empty result gracefully', () => {
    expect(formatSpO2([], null, 1)).toContain('No sleep readings for last night')
    expect(formatSpO2([], null, 7)).toContain('last 7 days')
    expect(findBanTerms(formatSpO2([], null, 7))).toEqual([])
  })

  it('summarises across nights when given more than one', () => {
    const text = formatSpO2(
      [night({ avg_spo2: 95 }), night({ night_of: '2026-07-02', avg_spo2: 97 })],
      baseline,
      2,
    )
    expect(text).toContain('Last 2 nights')
    expect(text).toContain('96% on average')
  })
})

describe('T-32 — every shipped formatter is guarded', () => {
  it('ships seven tools, all sharing the guarded finalize path', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({ analytics: engine as never })
    expect(Object.keys(handle.tools)).toHaveLength(7)
  })

  it('a clinical string in the DATA cannot reach the model', async () => {
    // getInsights interpolates insight titles straight into its text, so a
    // clinically-titled insight row is the realistic leak path — the copy
    // guard has to catch content it did not author.
    const engine = createFakeEngine()
    engine.queueRows('FROM insight', [
      {
        insight_id: 'i1',
        metric: 'spo2',
        kind: 'threshold',
        severity: 'warn',
        title: 'Nocturnal desaturation detected',
        body: null,
        fired_at: '2026-07-01T00:00:00Z',
        ts: '2026-07-01T00:00:00Z',
      },
    ])

    const handle = createAnalyticsTools({
      analytics: engine as never,
      rateLimit: false,
      authorize: async () => true,
    })
    handle.setContext({
      requesterUserId: 'alice',
      brand: 'ziva',
      familyId: 'fam1',
    } as never)

    const out = await handle.tools.getInsights.execute!(
      { userId: 'alice', days: 7 },
      {} as never,
    )
    // The wrapper turns the throw into an error result rather than
    // returning clinical text — either way the model never sees it.
    expect(String(out).toLowerCase()).not.toContain('desaturation')
    await handle.close()
  })
})

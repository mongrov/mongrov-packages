/**
 * The mock satisfies the contract it claims to.
 *
 * A mock that drifts from the types is worse than none: a screen builds green
 * against it and breaks on the real hooks. These assert the rules the contract
 * states in prose, which the type system cannot enforce — A2's state machine,
 * A3's mandatory freshness, A6's gap and cadence rules, A7's optimism.
 */

import { describe, expect, it } from 'vitest'

import {
  META,
  spo2DayEmpty,
  spo2DayLearning,
  spo2DayReady,
  spo2TrendReady,
} from '../mock/fixtures'

describe('A2 — the status contract', () => {
  it('returns a verdict only when ready', () => {
    expect(spo2DayReady().verdict).not.toBeNull()
    // The learning state renders, but the hook decides there is no verdict to
    // give before Day 30. A screen must not fill this in.
    expect(spo2DayLearning().verdict).toBeNull()
    expect(spo2DayEmpty('first-day').verdict).toBeNull()
  })

  it('withholds worthALook and factors while learning', () => {
    const learning = spo2DayLearning()
    expect(learning.worthALook).toBeNull()
    expect(learning.factors).toBeNull()
  })

  it('still carries meta copy in the empty states', () => {
    // The screen renders `VitalStateScreen` from meta — if meta were empty
    // here it would have nothing to say.
    for (const status of ['loading', 'no-sensor', 'first-day'] as const) {
      const view = spo2DayEmpty(status)
      expect(view.status).toBe(status)
      expect(view.meta.noSensor.length).toBeGreaterThan(0)
      expect(view.meta.firstRun.steps.length).toBeGreaterThan(0)
    }
  })

  it('gives learning its own chip copy rather than a verdict word', () => {
    expect(META.spo2.learningChip).toBe('Learning your usual')
  })
})

describe('A3 — freshness', () => {
  it('every Day view carries updatedAt', () => {
    // Mandatory. Placement is the screen's choice; dropping it is an
    // auto-reject, so the hook must always supply it.
    expect(spo2DayReady().updatedAt.label).toMatch(/updated/)
    expect(spo2DayLearning().updatedAt.label).toMatch(/updated/)
  })

  it('trend views do NOT carry one', () => {
    // "Trend views omit it — don't invent one."
    expect('updatedAt' in spo2TrendReady('week')).toBe(false)
  })
})

describe('A6 — the chart data contract', () => {
  it('marks.length equals the cadence slot count', () => {
    const day = spo2DayReady()
    // Never hard-code 48: next-gen rings change it, so the fixture must agree
    // with its own cadence rather than a literal.
    expect(day.marks).toHaveLength(day.cadence.slotCount)
  })

  it('represents a gap as a null value, not a missing slot', () => {
    const day = spo2DayReady()
    const gaps = day.marks.filter(m => m.value === null)
    expect(gaps.length).toBeGreaterThan(0)
    // The slot still exists so the screen can render the gap rather than
    // bridging across it.
    expect(gaps.every(m => m.zone === 'gap')).toBe(true)
    const slots = day.marks.map(m => m.slot)
    expect(slots).toEqual([...slots].sort((a, b) => a - b))
  })

  it('marks only hot where the hook flagged an exception', () => {
    const day = spo2DayReady()
    // A5: attention/alert appear only when the hook says so.
    for (const mark of day.marks) {
      if (mark.tone === 'attention' || mark.tone === 'alert')
        expect(mark.isException).toBe(true)
    }
  })

  it('sends the draggable setting dashed and the facts solid', () => {
    const lines = spo2DayReady().referenceLines
    const safeLevel = lines.find(l => l.id === 'safe-level')!
    expect(safeLevel.style).toBe('dashed')
    expect(safeLevel.draggable).toBe(true)

    const usual = spo2TrendReady('week').referenceLines.find(l => l.id === 'usual')!
    expect(usual.style).toBe('solid')
    expect(usual.draggable).toBeUndefined()
  })

  it('never sends the period average as a line — it lives in heroSub', () => {
    const day = spo2DayReady()
    expect(day.heroSub).toContain('96')
    expect(day.referenceLines.some(l => l.label.toLowerCase().includes('average'))).toBe(false)
  })

  it('carries the distribution core on trend days rather than making the screen derive it', () => {
    for (const d of spo2TrendReady('week').days) {
      expect(d.core).not.toBeNull()
      expect(d.core![0]).toBeLessThanOrEqual(d.core![1])
    }
  })
})

describe('A4 — everything the screen renders is pre-composed', () => {
  it('ships the hero number and unit separately and already formatted', () => {
    const day = spo2DayReady()
    // If a screen has to write `value + '%'`, that is our side of the
    // boundary leaking.
    expect(day.heroValue).toBe('96')
    expect(day.heroUnit).toBe('%')
  })

  it('pre-words every table status', () => {
    for (const row of spo2DayReady().table.rows)
      expect(row.status.length).toBeGreaterThan(0)
  })

  it('keeps banned vocabulary out of the strings a screen renders', () => {
    // SpO₂'s per-vital additions. The real guard is the copy pack's, applied
    // at composition; this catches a fixture that quietly reintroduces one.
    const day = spo2DayReady()
    const surfaces = [
      day.narrative,
      day.worthALook?.text ?? '',
      day.summaryBar.headline,
      day.summaryBar.subline,
      ...day.legend.map(l => l.label),
      ...day.table.rows.map(r => r.status),
    ].join(' ').toLowerCase()

    for (const banned of ['desaturation', 'hypoxemia', 'hypoxia'])
      expect(surfaces).not.toContain(banned)
  })
})

describe('B1 — SpO₂ specifics', () => {
  it('uses the locked zone ids', () => {
    const zones = new Set(spo2DayReady().marks.map(m => m.zone))
    for (const z of zones)
      expect(['typical', 'slightly-low', 'low', 'gap']).toContain(z)
  })

  it('sends deepestDip only when there was one', () => {
    expect(spo2DayReady().deepestDip).not.toBeNull()
    // No verdict, no dip callout — nothing to compare against yet.
    expect(spo2DayLearning().deepestDip).toBeNull()
  })
})

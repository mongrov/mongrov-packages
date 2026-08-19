/**
 * A2's ladder, including the orderings that make it correct.
 *
 * The happy path is uninteresting. What matters is that each rung subsumes
 * the ones below it, so a case that satisfies two rungs must resolve to the
 * higher one — and each of those is a screen a real user would otherwise be
 * shown wrongly.
 */

import { describe, expect, it } from 'vitest'

import { allowsVerdict, BASELINE_READY_DAYS, rendersData, resolveVitalStatus } from '../status'

const ready = {
  isLoading: false,
  hasCadence: true,
  daysWorn: 45,
  baselineSampleCount: 30,
}

describe('the ladder resolves top-down', () => {
  it('returns ready when everything is satisfied', () => {
    expect(resolveVitalStatus(ready)).toBe('ready')
  })

  it('loading outranks everything, because absent data looks like no data', () => {
    // Mid-fetch, an empty result is indistinguishable from a ring never worn.
    expect(resolveVitalStatus({
      isLoading: true,
      hasCadence: false,
      daysWorn: 0,
      baselineSampleCount: null,
    })).toBe('loading')
  })

  it('no-sensor beats first-day — a sensorless ring also has zero days', () => {
    // The bug this prevents: a ring that cannot measure SpO2 showing a
    // checklist telling the user to wear it overnight and sync.
    expect(resolveVitalStatus({
      ...ready,
      hasCadence: false,
      daysWorn: 0,
      baselineSampleCount: null,
    })).toBe('no-sensor')
  })

  it('no-sensor beats learning too', () => {
    expect(resolveVitalStatus({ ...ready, hasCadence: false })).toBe('no-sensor')
  })

  it('first-day beats learning — a day-1 user also lacks a baseline', () => {
    // The bug this prevents: an empty chart with a "Learning your usual" chip
    // instead of the first-run steps.
    expect(resolveVitalStatus({
      ...ready,
      daysWorn: 0,
      baselineSampleCount: 0,
    })).toBe('first-day')
  })

  it('learning until the baseline reaches the Day-30 gate', () => {
    expect(resolveVitalStatus({ ...ready, baselineSampleCount: BASELINE_READY_DAYS - 1 }))
      .toBe('learning')
    expect(resolveVitalStatus({ ...ready, baselineSampleCount: BASELINE_READY_DAYS }))
      .toBe('ready')
  })

  it('treats a missing baseline row as zero, not as ready', () => {
    // `null` means the compute has not run. Falling through to ready would
    // show a personal comparison against a baseline that does not exist.
    expect(resolveVitalStatus({ ...ready, baselineSampleCount: null })).toBe('learning')
  })

  it('does not confuse days worn with baseline maturity', () => {
    // 45 days worn but a baseline of 12 — possible after a warehouse rebuild.
    // The baseline is what a verdict compares against, so this is learning.
    expect(resolveVitalStatus({ ...ready, daysWorn: 45, baselineSampleCount: 12 }))
      .toBe('learning')
  })
})

describe('what each status permits', () => {
  it('renders data while learning, but grants no verdict', () => {
    // The distinction screens get wrong: the chart draws, the verdict does
    // not exist.
    expect(rendersData('learning')).toBe(true)
    expect(allowsVerdict('learning')).toBe(false)
  })

  it('grants a verdict only when ready', () => {
    expect(allowsVerdict('ready')).toBe(true)
    for (const s of ['loading', 'no-sensor', 'first-day', 'learning'] as const)
      expect(allowsVerdict(s)).toBe(false)
  })

  it('renders nothing for the empty states', () => {
    for (const s of ['loading', 'no-sensor', 'first-day'] as const)
      expect(rendersData(s)).toBe(false)
  })
})

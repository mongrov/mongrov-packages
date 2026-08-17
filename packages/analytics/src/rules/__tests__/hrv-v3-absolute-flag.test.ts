/**
 * T-19 — the guards, verified against HRV v3 as the test case.
 *
 * An absolute HRV flag has now been designed three separate times. The most
 * recent creative shipped `thresh: 35`, and the sprint6 tracker's conclusion
 * was that the T-05/T-14 guards are the fix — not another review note, since
 * review has already caught this twice and it came back.
 *
 * A guard nobody has fired is a guard nobody has tested. This reconstructs the
 * actual defect and drives it through `registry.register()` — the real
 * admission path — rather than calling the validator directly, because a rule
 * only reaches a user by being registered.
 *
 * The rule under test is deliberately WELL-FORMED. It parses, it validates
 * structurally, every field is the right type. Nothing but the D3 admission
 * policy stands between it and production, which is precisely why the policy
 * lives at registration rather than in `validateRule`.
 */

import { describe, expect, it } from 'vitest'

import { assertRegistrable, RuleValidationError, validateRule } from '../validator'

/**
 * HRV v3's flag, as designed: alert when HRV drops below 35 ms.
 *
 * The number is not the problem — 35 ms is alarming for one person and
 * unremarkable for another, which is the whole of decision D3.
 */
const HRV_V3_ABSOLUTE_FLAG = {
  id: 'ziva.hrv-below-35',
  brand: 'ziva',
  name: 'Low HRV',
  description: 'HRV below 35 ms',
  metric: 'hrv_ms',
  window: '24h',
  aggregation: 'avg',
  compare: 'less_than',
  severity: 'warn',
  target: { type: 'absolute', value: 35 },
  throttle: { minGapMinutes: 720, maxPerDay: 1 },
} as const

describe('T-19 — HRV v3 absolute flag is refused admission', () => {
  it('is structurally well-formed — the guard is the only thing stopping it', () => {
    // If this ever throws, the test below stops proving what it claims: the
    // rule would be failing for a shape reason rather than the D3 policy.
    expect(() => validateRule(HRV_V3_ABSOLUTE_FLAG as never)).not.toThrow()
  })

  it('is rejected at registration', () => {
    expect(() => assertRegistrable(HRV_V3_ABSOLUTE_FLAG as never))
      .toThrow(RuleValidationError)
  })

  it('names D3 and the alternatives in the error', () => {
    // The message is the whole intervention. A designer who hits this needs to
    // know why and what to use instead, or it comes back a fourth time.
    let message = ''
    try {
      assertRegistrable(HRV_V3_ABSOLUTE_FLAG as never)
    }
    catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('D3')
    expect(message).toContain('baseline_offset')
    expect(message).toContain('baseline_percent')
  })

  it('also refuses the range and user_setting escape hatches', () => {
    // An absolute threshold wearing a different hat is still absolute. A
    // user-draggable HRV number is the same defect with extra steps.
    for (const target of [
      { type: 'range', min: 35, max: 90 },
      { type: 'user_setting', key: 'user:hrvFloor' },
    ]) {
      expect(
        () => assertRegistrable({ ...HRV_V3_ABSOLUTE_FLAG, target } as never),
        `target.type '${target.type}' should be refused`,
      ).toThrow(RuleValidationError)
    }
  })

  it('admits the relative form the guard points authors towards', () => {
    // The guard must not be a wall. `ziva.hrv-drop-30` — the shipped default —
    // expresses the same intent relatively and has to pass.
    const relative = {
      ...HRV_V3_ABSOLUTE_FLAG,
      id: 'ziva.hrv-drop-30',
      target: { type: 'baseline_percent', windowDays: 7, percent: 70 },
    }
    expect(() => assertRegistrable(relative as never)).not.toThrow()
  })

  it('leaves other metrics free to use absolute thresholds', () => {
    // D3 is about HRV specifically. Sleep minutes and step counts are absolute
    // by nature, and a guard that caught them would be wrong.
    const sleep = {
      ...HRV_V3_ABSOLUTE_FLAG,
      id: 'ziva.sleep-short',
      metric: 'sleep_minutes',
      target: { type: 'absolute', value: 300 },
    }
    expect(() => assertRegistrable(sleep as never)).not.toThrow()
  })
})

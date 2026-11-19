/**
 * The health pack's additions to the rules engine: sample contexts
 * (`asleep`, `resting`), per-metric window minimums, the HRV relative-only
 * policy (D3), the per-session context check, and the ZivaOne settings
 * registry `user_setting` targets read.
 */

import type { RuleContextArgs, RulePack } from '../../core/packs'
import { isRegisteredKvKey, isRuleReadableKvKey, KV_KEY_REGISTRY, ruleReadableKvKeys } from '@mongrov/types/kv-keys'
import { viewFor } from '../../rules/compiler'
import { RuleValidationError } from '../../rules/schema'
import { METRIC_METADATA } from './metrics'
import { isQualityTable, qualityViewFor, stillEnoughSql } from './reading-quality'

/**
 * T-17 — INNER JOIN restricting samples to a physiological context.
 *
 * Both joins carry the full tenant triple, not just `user_id`: a join on
 * user alone would match another brand's sleep sessions for the same person
 * on a multi-brand install.
 *
 * - `asleep`  — samples falling inside a `v_sleep_session` interval
 * - `resting` — samples with no movement around them (below)
 */
function asleep(): string {
  return `
INNER JOIN ${viewFor('sleep_session')} s
   ON s.user_id = m.user_id
  AND s.brand = m.brand
  AND s.family_id = m.family_id
  AND m.ts BETWEEN s.ts_start AND s.ts_end`
}

function resting({ table, qualityRelation }: RuleContextArgs): string {
  /*
     * "Resting" is the ABSENCE of movement around the sample, not the
     * presence of a zero-step row at its exact minute.
     *
     * The earlier form required an activity row to exist at
     * date_trunc('minute', m.ts) with steps = 0, and being an INNER JOIN it
     * dropped every sample that had no activity row at all. Two consequences,
     * both wrong:
     *
     *   1. A device that only reports activity when the user moves — which is
     *      most of them — produces NO resting samples, so a resting-gated
     *      rule silently never fires.
     *   2. It disagreed with the definition of "resting" everywhere else. The
     *      HR slot table gates the flag rule on "no v_activity steps +/-15
     *      min", `hr.restingVsUsual` uses exactly that, and the three
     *      registries define `active` as steps > 0 within +/-15 min. Resting
     *      has to be the complement of active or a reading can be neither,
     *      and a rule and a screen would say different things about it.
     *
     * ANTI JOIN keeps this in the join position while inverting the meaning:
     * the sample survives when no movement row matches the window.
     *
     * mongrov-packages#6 — and "movement" is the §7g FLOOR, not `steps > 0`.
     * A worn ring logs a few steps in most waking minutes; 0.27.0 moved the
     * chart's `still` flag and the baseline's resting average to "fewer than
     * STILL_FLOOR steps in the window", and this gate was the one site left
     * on `steps > 0`, so a reading could be still on the chart and moving
     * for the rule that alerts on it.
     *
     * A floor is a SUM, which an anti join cannot express. For a metric
     * with quality flags the gate therefore joins the reading to its own row
     * in `v_<table>_q` and requires `still` — the very flag the charts read,
     * proven row-for-row equal to the windowed sum in 0.27.0. Still a join,
     * so `emitContextJoin` keeps its shape and the aggregate semantics the
     * "context is a JOIN" test protects. Do NOT put the floor inside an ASOF
     * ON clause: ASOF then hunts for a nearer passing row instead of
     * measuring the window (disproven on 864 readings, see #6).
     *
     * Tables without quality flags keep the row-existence form below.
     *
     * `stillEnoughSql`, not a bare `rq.still` (zivaone_app#219). `still` is
     * three-valued now — NULL where no activity row falls inside the window,
     * so stillness is unknown rather than established. An INNER JOIN on a
     * NULL drops the row, which would stop resting-gated rules firing
     * exactly when activity coverage is sparse: overnight, which is when a
     * resting rule matters most.
     *
     * Sharing the expression with the clean views is the point. They keep
     * unknown readings, and if this gate did not, a reading would be still
     * on the chart and moving for the rule that alerts on it -- the drift
     * this comment says 0.27.0 removed, reintroduced by a different route.
     */
  if (table !== '' && isQualityTable(table)) {
    return `
INNER JOIN ${qualityRelation ?? qualityViewFor(table)} rq
   ON rq.user_id = m.user_id
  AND rq.brand = m.brand
  AND rq.family_id = m.family_id
  AND rq.device_id = m.device_id
  AND rq.ts = m.ts
  AND ${stillEnoughSql('rq.')}`
  }
  return `
ANTI JOIN ${viewFor('activity')} a
   ON a.user_id = m.user_id
  AND a.brand = m.brand
  AND a.family_id = m.family_id
  AND a.steps > 0
  AND a.ts >= m.ts - INTERVAL 15 MINUTE
  AND a.ts <  m.ts + INTERVAL 15 MINUTE`
}

/**
 * Explicit table per spec §Sampling-minimum validator. The remaining
 * exposed metrics fall through to a list derived from `sampling_minutes`.
 */
const WINDOWS: Readonly<Record<string, readonly string[]>> = {
  hrv_ms: ['24h', '3d', '7d', '30d'],
  stress: ['6h', '24h', '3d', '7d', '30d'],
  hr_bpm: ['1h', '6h', '24h', '3d', '7d', '30d'],
  spo2: ['6h', '24h', '3d', '7d', '30d'],
  temp_c: ['24h', '3d', '7d', '30d'],
  activity_steps: ['1h', '6h', '24h', '3d', '7d', '30d'],
  sleep_total_minutes: ['3d', '7d'],
  device_battery: ['1h', '6h', '24h'],
}

/**
 * D3 — HRV rules are relative-only (sprint6 §4).
 *
 * There is no meaningful absolute HRV threshold: 30 ms is alarming for one
 * person and unremarkable for another, so a fixed flag is a number that means
 * something different for every user who sees it.
 *
 * This is a validator rather than a review note because review has already
 * failed at it. Every generation of the HRV screen so far has shipped an
 * absolute flag — the most recent as `thresh: 35` on a drag control — and
 * each was caught by a person, late, after the work was done. Code catches
 * it whoever writes it and whenever they write it.
 *
 * `user_setting` is absolute too: letting the user pick 35 ms does not make
 * 35 ms mean anything. Relative targets (`baseline_percent`,
 * `baseline_stddev`, `baseline_offset`) are the whole permitted set.
 *
 * Admission policy, checked at REGISTRATION rather than inside
 * `validateRule`: unit tests use `hrv_ms` as an ordinary metric to exercise
 * the compiler's absolute branch and the window minimums.
 */
const RELATIVE_ONLY_METRICS = new Set(['hrv_ms'])
const ABSOLUTE_TARGET_TYPES = new Set(['absolute', 'range', 'user_setting'])

function admit(rule: { id: string, metric: string, target: { type: string } }): void {
  if (!RELATIVE_ONLY_METRICS.has(rule.metric))
    return
  if (!ABSOLUTE_TARGET_TYPES.has(rule.target.type))
    return

  throw new RuleValidationError(
    `Rule ${rule.id}: metric ${rule.metric} is relative-only (decision D3) — `
    + `target.type '${rule.target.type}' sets an absolute threshold. There is `
    + `no HRV number that means the same thing for two people; compare against `
    + `the user's own baseline instead (baseline_offset, baseline_percent or `
    + `baseline_stddev). See .specifica/hrv/spec.md D3.`,
  )
}

/**
 * T-21 — context compatibility.
 *
 * `context: 'asleep'` JOINs `v_sleep_session` on the metric's `ts`, so a
 * metric whose own time axis IS the sleep session (sleep_total_minutes)
 * would self-join meaninglessly.
 */
function validate(rule: { id: string, metric: string, context: string }): void {
  if (rule.context === 'any')
    return
  const table = (METRIC_METADATA as Record<string, { table: string }>)[rule.metric]?.table
  if (table === 'sleep_session') {
    throw new RuleValidationError(
      `Rule ${rule.id}: context '${rule.context}' is redundant for metric `
      + `${rule.metric} — it is already a per-session measure. Use context 'any'.`,
    )
  }
}

export const healthRules: RulePack = {
  contexts: { asleep, resting },
  windows: WINDOWS,
  validate,
  admit,
  settings: {
    readable: key => isRuleReadableKvKey(key),
    registered: key => isRegisteredKvKey(key),
    valueType: key => (KV_KEY_REGISTRY as Record<string, { valueType?: string }>)[key]?.valueType,
    range: key => (KV_KEY_REGISTRY as Record<string, { range?: readonly [number, number] }>)[key]?.range,
    readableKeys: () => ruleReadableKvKeys(),
    registryName: 'KV_KEY_REGISTRY in @mongrov/types/kv-keys',
  },
  defaultBrand: 'ziva',
}

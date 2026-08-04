/**
 * Ziva brand default rules.
 *
 * The template string below is a verbatim copy of `ziva.toml`. Edit the
 * TOML sidecar, then either run `scripts/sync-toml.mjs` or copy-paste
 * back into this literal. Metro/tsup do not read `.toml` files directly.
 */

import { parseCatalog } from './loader'
import type { Rule } from '../schema'

const TOML = `
# Ziva brand default rules.
#
# Copied verbatim into \`ziva.ts\` as an inline template string. Do NOT edit
# the wrapper file directly — treat this .toml as the source of truth.
#
# Rules cover the core Ziva health surface: HRV drop, sleep deprivation,
# elevated stress, and low weekly activity. Verbatim from
# \`.specifica/features/analytics-rules/spec.md\` §Brand defaults.
#
# Two of these deliberately use relative targets rather than absolutes:
# \`baseline_percent\` (HRV) and \`baseline_stddev\` (stress). A fixed HRV
# threshold is meaningless across users — 30 ms is alarming for one person
# and unremarkable for another — so the shipped catalog exercises the
# compiler's baseline paths, not just the absolute path.

[[rule]]
id = "ziva.hrv-drop-30"
brand = "ziva"
name = "Sudden HRV drop"
description = "HRV dropped 30% below 7-day baseline"
metric = "hrv_ms"
window = "24h"
aggregation = "avg"
compare = "less_than"
severity = "warn"

[rule.target]
type = "baseline_percent"
windowDays = 7
percent = 70

[rule.throttle]
minGapMinutes = 720
maxPerDay = 1

[[rule]]
id = "ziva.sleep-deprivation-3"
brand = "ziva"
name = "Three nights short sleep"
description = "Average nightly sleep across 3 nights below 300 minutes."
metric = "sleep_total_minutes"
window = "3d"
aggregation = "avg"
compare = "less_than"
severity = "info"

[rule.target]
type = "absolute"
value = 300

[rule.throttle]
minGapMinutes = 1440
maxPerDay = 1

[[rule]]
id = "ziva.stress-elevated-day"
brand = "ziva"
name = "Elevated stress today"
description = "Daily average stress rose 1.5 standard deviations above the 14-day baseline."
metric = "stress"
window = "24h"
aggregation = "avg"
compare = "greater_than"
severity = "info"

[rule.target]
type = "baseline_stddev"
windowDays = 14
stddevs = 1.5

[rule.throttle]
minGapMinutes = 1440
maxPerDay = 1

[[rule]]
id = "ziva.low-activity-week"
brand = "ziva"
name = "Low activity all week"
description = "Total steps across the last 7 days below 20,000."
metric = "activity_steps"
window = "7d"
aggregation = "sum"
compare = "less_than"
severity = "info"

[rule.target]
type = "absolute"
value = 20000

[rule.throttle]
minGapMinutes = 10080
maxPerDay = 1

# ─────────────────────────────────────────────────────────────────────────
# SpO₂ — two rules that coexist deliberately (Sprint 5 §4, Ziva #1).
#
# A is the LOUD one: the alert the user configured in the ⚙ sheet, firing
# on a single reading below their own safe level, day or night.
# B is a SECONDARY pattern insight: a sustained nightly dip, which is a
# different observation and belongs in the feed rather than as an alert.
# They fire independently and hold independent throttle state.
# ─────────────────────────────────────────────────────────────────────────

[[rule]]
id = "ziva.spo2-safe-level"
brand = "ziva"
name = "SpO₂ below your safe level"
description = "Alerts on any single reading below your configured safe level"
metric = "spo2"
# 24h, NOT 1h. Rules evaluate at batch:complete, and a morning sync
# delivers ~8 hours of overnight readings in one batch. A wall-clock 1h
# window would silently miss anything older than an hour before eval —
# including the exact overnight crossings the "day or night" promise
# exists for. 24h covers the batch delivery envelope; the throttle below
# prevents duplicate fires from re-scanned data.
window = "24h"
aggregation = "min"
compare = "less_than"
context = "any"
consecutive = 1
severity = "warn"

[rule.target]
type = "user_setting"
key = "user:spo2SafeLevel"
defaultValue = 90

[rule.throttle]
minGapMinutes = 60
maxPerDay = 3

[[rule]]
id = "ziva.spo2-desaturation-asleep"
brand = "ziva"
name = "Nightly low SpO₂ pattern"
description = "Pattern of low SpO₂ during sleep — 3 consecutive samples below 88"
metric = "spo2"
window = "24h"
aggregation = "min"
compare = "less_than"
context = "asleep"
consecutive = 3
severity = "info"

[rule.target]
type = "absolute"
value = 88

[rule.throttle]
minGapMinutes = 720
maxPerDay = 1
`

export const zivaDefaults: Rule[] = parseCatalog(TOML, { name: 'ziva' })

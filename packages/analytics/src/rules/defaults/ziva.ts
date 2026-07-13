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
[[rule]]
id = "ziva.hrv-drop-30"
brand = "ziva"
name = "HRV drop below 30 ms"
description = "Average HRV over the last 24h fell below 30 ms."
metric = "hrv_ms"
window = "24h"
aggregation = "avg"
compare = "less_than"
severity = "warn"

[rule.target]
type = "absolute"
value = 30

[rule.throttle]
minGapMinutes = 360
maxPerDay = 2

[[rule]]
id = "ziva.sleep-deprivation-3d"
brand = "ziva"
name = "Sleep deprivation"
description = "Average nightly sleep across 3 nights below 360 minutes."
metric = "sleep_total_minutes"
window = "3d"
aggregation = "avg"
compare = "less_than"
severity = "warn"

[rule.target]
type = "absolute"
value = 360

[rule.throttle]
minGapMinutes = 720
maxPerDay = 1

[[rule]]
id = "ziva.stress-elevated"
brand = "ziva"
name = "Elevated stress"
description = "Average stress score over 6h rose above 70."
metric = "stress"
window = "6h"
aggregation = "avg"
compare = "greater_than"
severity = "info"

[rule.target]
type = "absolute"
value = 70

[rule.throttle]
minGapMinutes = 120
maxPerDay = 3

[[rule]]
id = "ziva.activity-low-24h"
brand = "ziva"
name = "Low activity"
description = "Daily step count is below 3000."
metric = "activity_steps"
window = "24h"
aggregation = "sum"
compare = "less_than"
severity = "info"

[rule.target]
type = "absolute"
value = 3000

[rule.throttle]
minGapMinutes = 720
maxPerDay = 1
`

export const zivaDefaults: Rule[] = parseCatalog(TOML, { name: 'ziva' })

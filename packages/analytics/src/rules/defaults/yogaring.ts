/**
 * YogaRing brand default rules. Sidecar: `yogaring.toml`.
 */

import { parseCatalog } from './loader'
import type { Rule } from '../schema'

const TOML = `
[[rule]]
id = "yogaring.stress-elevated"
brand = "yogaring"
name = "YogaRing stress nudge"
description = "Average stress score over 6h rose above 65."
metric = "stress"
window = "6h"
aggregation = "avg"
compare = "greater_than"
severity = "info"

[rule.target]
type = "absolute"
value = 65

[rule.throttle]
minGapMinutes = 240
maxPerDay = 2

[[rule]]
id = "yogaring.activity-low"
brand = "yogaring"
name = "YogaRing activity nudge"
description = "Daily step count is below 2500."
metric = "activity_steps"
window = "24h"
aggregation = "sum"
compare = "less_than"
severity = "info"

[rule.target]
type = "absolute"
value = 2500

[rule.throttle]
minGapMinutes = 720
maxPerDay = 1
`

export const yogaringDefaults: Rule[] = parseCatalog(TOML, { name: 'yogaring' })

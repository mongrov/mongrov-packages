/**
 * LuminX brand default rules. Sidecar: `luminx.toml`.
 */

import type { Rule } from '../schema'
import { parseCatalog } from './loader'

const TOML = `
# LuminX brand default rules.
#
# LuminX rules are asset-side: battery low, prolonged disconnect, and
# firmware/status. All three run against the \`device_event\` table, whose
# metric proxy \`device_battery\` gates evaluation on batch.
#
# See \`luminx.ts\` — this file is the source of truth.

[[rule]]
id = "luminx.battery-low"
brand = "luminx"
name = "LuminX battery low"
description = "Device battery below 15% in the past hour."
metric = "device_battery"
window = "1h"
aggregation = "last"
compare = "less_than"
severity = "warn"

[rule.target]
type = "absolute"
value = 15

[rule.throttle]
minGapMinutes = 240
maxPerDay = 3

[[rule]]
id = "luminx.battery-critical"
brand = "luminx"
name = "LuminX battery critical"
description = "Device battery below 5% — connectivity likely to drop."
metric = "device_battery"
window = "1h"
aggregation = "last"
compare = "less_than"
severity = "critical"

[rule.target]
type = "absolute"
value = 5

[rule.throttle]
minGapMinutes = 60
maxPerDay = 4

[[rule]]
id = "luminx.disconnect-24h"
brand = "luminx"
name = "LuminX disconnected"
description = "No device battery events observed in the past 24h."
metric = "device_battery"
window = "24h"
aggregation = "count"
compare = "equals"
severity = "warn"

[rule.target]
type = "absolute"
value = 0

[rule.throttle]
minGapMinutes = 720
maxPerDay = 1
`

export const luminxDefaults: Rule[] = parseCatalog(TOML, { name: 'luminx' })

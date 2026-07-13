/**
 * Viva brand default rules. Sidecar: `viva.toml`.
 */

import { parseCatalog } from './loader'
import type { Rule } from '../schema'

const TOML = `
[[rule]]
id = "viva.battery-low"
brand = "viva"
name = "Viva battery low"
description = "Device battery below 20% in the past hour."
metric = "device_battery"
window = "1h"
aggregation = "last"
compare = "less_than"
severity = "warn"

[rule.target]
type = "absolute"
value = 20

[rule.throttle]
minGapMinutes = 360
maxPerDay = 2

[[rule]]
id = "viva.disconnect-24h"
brand = "viva"
name = "Viva disconnected"
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

export const vivaDefaults: Rule[] = parseCatalog(TOML, { name: 'viva' })

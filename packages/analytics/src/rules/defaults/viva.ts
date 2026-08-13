/**
 * Viva brand default rules. Sidecar: `viva.toml`.
 */

import type { Rule } from '../schema'
import { parseCatalog } from './loader'

const TOML = `
# Viva brand default rules (placeholder set for v0.1.0).
#
# Viva is asset-focused; rules mirror the LuminX asset-threshold pattern
# for battery + connectivity. Refined once product surfaces land.
#
# See \`viva.ts\` — this file is the source of truth.

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

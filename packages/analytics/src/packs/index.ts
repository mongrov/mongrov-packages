/**
 * Domain packs that still ship inside the package (package-separation
 * S-02). Registered by default so a consumer that registers none keeps the
 * ≤ 0.52 behaviour. S-03 moves them to the app's `@zivaone/*` packs.
 */

import type { AnalyticsPack } from '../core/packs'
import { healthPack } from './health'
import { ringPack } from './ring'

export const DEFAULT_PACKS: readonly AnalyticsPack[] = [healthPack, ringPack]

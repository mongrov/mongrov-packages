/** The test packs every suite runs with (see ./setup.ts). */

import type { AnalyticsPack } from '../../core/packs'
import { healthPack } from './health'
import { ringPack } from './ring'

export const DEFAULT_PACKS: readonly AnalyticsPack[] = [healthPack, ringPack]

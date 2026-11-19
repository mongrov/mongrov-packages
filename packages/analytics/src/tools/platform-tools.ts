/**
 * The platform's own AI tool: recent insights (the platform `insight`
 * table). Offered after every pack's tools.
 */

import type { PackTool } from '../core/packs'
import { getInsights, getInsightsInputSchema } from './impls/insights'

export const platformTools: Readonly<Record<string, PackTool>> = {
  getInsights: {
    description: 'Return recent AI-generated insights for a user. Args: userId, '
      + 'days (1..30, default 7), optional severity (info|warn|urgent).',
    inputSchema: getInsightsInputSchema,
    impl: getInsights,
  },
}

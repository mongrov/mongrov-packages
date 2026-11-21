/**
 * The platform's own AI tool: recent insights (the platform `insight`
 * table). Offered after every pack's tools.
 */

import type { PackTool } from '../core/packs'
import { getInsights, getInsightsInputSchema } from './impls/insights'

export const platformTools: Readonly<Record<string, PackTool>> = {
  getInsights: {
    // Exactly what the tool reads and prints; no argument the model never
    // sees (the host supplies the person), no field it does not return.
    description: 'Recent notices the app raised from the user\'s data, newest first: '
      + 'severity, local date and time, title and text. '
      + 'days: how far back, 1 to 30 (default 7). severity: optional, info, warn or urgent.',
    inputSchema: getInsightsInputSchema,
    impl: getInsights,
  },
}

/**
 * A domain-free structured tool and a handle around it, shared by the
 * structured-result tests. The tool reports a numeric series over a window of
 * local days: a summary plus a newest-first list of items.
 */

import type { PackTool } from '../../../core/packs'
import type { ToolOutcome } from '../../outcome'
import type { AnalyticsToolsConfig, AuditEntry, AuditWriter, ToolContext, ToolResultEvent } from '../../types'
import { z } from 'zod'
import { createFakeEngine } from '../../__fakes__/engine'
import { defineTool } from '../../define'
import { createAnalyticsTools } from '../../factory'
import { outcome } from '../../outcome'

export const NOW = new Date('2026-11-21T10:00:00Z')

export const ctx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'acme',
  familyId: 'fam-1',
  timezone: 'Asia/Kolkata',
  now: () => NOW,
}

export const SeriesInput = z.object({
  userId: z.string(),
  period: z.enum(['this_week', 'last_7_days', 'last_30_days']).optional(),
})

export const SeriesOutput = z.object({
  label: z.string(),
  avgValue: z.number().nullable(),
  summary: z.object({ daysWithData: z.number().int(), daysExpected: z.number().int() }),
  items: z.array(z.object({
    date: z.string(),
    weekday: z.string(),
    value: z.number().nullable(),
    note: z.string().nullable(),
  })).max(31),
})

export type SeriesData = z.infer<typeof SeriesOutput>

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** `n` items, newest first, ending at 2026-11-21. */
export function items(n: number): SeriesData['items'] {
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 21 - i))
    return {
      date: d.toISOString().slice(0, 10),
      weekday: WEEKDAYS[d.getUTCDay()],
      value: i % 5 === 3 ? null : 40 + i,
      note: i === 0 ? 'so far' : null,
    }
  })
}

export function seriesData(n = 3): SeriesData {
  return { label: 'Steady', avgValue: 42.5, summary: { daysWithData: n, daysExpected: n }, items: items(n) }
}

export const WINDOW = Object.freeze({ from: '2026-11-15', to: '2026-11-21', timezone: 'Asia/Kolkata', partialToday: true, label: 'last_7_days' })

export function okOutcome(n = 3): ToolOutcome<SeriesData> {
  return outcome.ok(seriesData(n), { window: WINDOW, asOf: '2026-11-21T09:48:00Z', guidance: ['Today is still in progress; say so far.'] })
}

/** A structured tool whose impl returns whatever `result` yields (default: `okOutcome()`). */
export function seriesTool(
  result: (input: z.infer<typeof SeriesInput>) => Promise<unknown> | unknown = () => okOutcome(),
  extra: Partial<PackTool> = {},
): PackTool & { name: string } {
  return {
    ...defineTool({
      name: 'getSeries',
      title: 'Series',
      description: 'Daily values over a period, with the average.',
      inputSchema: SeriesInput,
      outputSchema: SeriesOutput,
      budget: { listPaths: ['items'] },
      impl: async input => (await result(input)) as never,
    }),
    ...extra,
  } as PackTool & { name: string }
}

export function fakeAudit(): AuditWriter & { records: AuditEntry[] } {
  const records: AuditEntry[] = []
  return { records, record: e => records.push(e), flush: async () => {}, close: async () => {} }
}

export function setup(config: Partial<AnalyticsToolsConfig> = {}) {
  const audit = fakeAudit()
  const events: ToolResultEvent[] = []
  const handle = createAnalyticsTools({
    analytics: createFakeEngine(),
    rateLimit: false,
    familyMembersProvider: async () => ['alice'],
    clock: () => NOW.getTime(),
    ...config,
  })
  handle.auditWriter.record = audit.record
  handle.onResult(e => events.push(e))
  handle.setContext(ctx)
  return { handle, audit, events }
}

export function call(t: { execute?: (...a: never[]) => unknown }, args: unknown, options: object = {}): Promise<string> {
  return (t.execute as (a: unknown, o: object) => Promise<string>)(args, options)
}

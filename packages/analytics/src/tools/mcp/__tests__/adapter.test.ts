import type { ToolContext } from '../../types'
import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../../__fakes__/engine'
import { createAnalyticsTools } from '../../factory'
import { toMcpTools } from '../adapter'

const baseCtx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('toMcpTools', () => {
  it('emits one MCP descriptor per wrapped tool with description + JSON Schema', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    const mcp = toMcpTools(handle)
    const names = mcp.map(t => t.name).sort()
    expect(names).toEqual([
      'compareTrend',
      'detectAnomaly',
      'getActivityTotal',
      'getHRV',
      'getInsights',
      'getSleepSummary',
      'getSpO2',
    ])
    for (const tool of mcp) {
      expect(typeof tool.description).toBe('string')
      expect(tool.description.length).toBeGreaterThan(0)
      expect(tool.inputSchema).toBeTypeOf('object')
      // JSON Schema draft-7 flavour — no `$schema` marker.
      expect(tool.inputSchema).not.toHaveProperty('$schema')
      expect(typeof tool.handler).toBe('function')
    }
  })

  it('converts getHRV Zod schema into an object schema with userId + days', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    const mcp = toMcpTools(handle)
    const hrv = mcp.find(t => t.name === 'getHRV')!
    const schema = hrv.inputSchema as {
      type?: string
      properties?: Record<string, unknown>
      required?: string[]
    }
    expect(schema.type).toBe('object')
    expect(schema.properties).toHaveProperty('userId')
    expect(schema.properties).toHaveProperty('days')
    expect(schema.required).toContain('userId')
    expect(schema.required).toContain('days')
  })

  it('preserves .default() values on detectAnomaly + getInsights', () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    const mcp = toMcpTools(handle)

    const anomaly = mcp.find(t => t.name === 'detectAnomaly')!
    const anomalyProps = (anomaly.inputSchema as {
      properties: Record<string, { default?: unknown }>
    }).properties
    expect(anomalyProps.stddevThreshold?.default).toBe(2)

    const insights = mcp.find(t => t.name === 'getInsights')!
    const insightsProps = (insights.inputSchema as {
      properties: Record<string, { default?: unknown }>
    }).properties
    expect(insightsProps.days?.default).toBe(7)
  })

  it('handler wraps execute output in MCP { content: [{ type: text, text }] } shape', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM hrv', [
      { day: '2026-07-10', avg_hrv: 42.5 },
      { day: '2026-07-11', avg_hrv: 44.0 },
    ])
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    handle.setContext(baseCtx)
    const mcp = toMcpTools(handle)
    const hrv = mcp.find(t => t.name === 'getHRV')!

    const result = await hrv.handler({ userId: 'alice', days: 7 })
    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    expect(result.content[0].text).toContain('HRV')
    expect(result.isError).toBeUndefined()
    await handle.close()
  })

  it('handler surfaces the wrapper\'s no-context error rather than throwing', async () => {
    const engine = createFakeEngine()
    const handle = createAnalyticsTools({
      analytics: engine,
      rateLimit: false,
      audit: { enabled: false },
    })
    // Intentionally skip setContext.
    const mcp = toMcpTools(handle)
    const hrv = mcp.find(t => t.name === 'getHRV')!
    const result = await hrv.handler({ userId: 'alice', days: 7 })
    expect(result.content[0].text).toContain('context not set')
    await handle.close()
  })
})

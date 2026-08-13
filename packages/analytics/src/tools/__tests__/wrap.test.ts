import type { RateLimiter } from '../rate-limit'
import type {
  AuditEntry,
  AuditWriter,
  AuthorizeFn,
  OutputBudget,
  ToolContext,
  ToolImpl,
  ToolResult,
} from '../types'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createFakeEngine } from '../__fakes__/engine'
import { makeTool } from '../wrap'

const schema = z.object({ userId: z.string(), days: z.number() })
type Input = z.infer<typeof schema>

const baseCtx: ToolContext = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

const defaultBudget: OutputBudget = { maxBytes: 4096, maxRows: 100 }

function createFakeAudit(): AuditWriter & { records: AuditEntry[] } {
  const records: AuditEntry[] = []
  return {
    records,
    record(entry) { records.push(entry) },
    async flush() {},
    async close() {},
  }
}

function createFakeLimiter(shouldAllow: boolean): RateLimiter & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    check(toolName, userId) {
      calls.push(`${toolName}:${userId}`)
      return shouldAllow
    },
  }
}

function makeResult(text: string, rowCount = 1): ToolResult {
  return { text, rowCount, bytes: new TextEncoder().encode(text).byteLength }
}

describe('makeTool', () => {
  it('success path writes success audit row with latency and byte metrics', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    let tick = 100
    const impl: ToolImpl<Input> = async () => makeResult('hello world', 3)
    const t = makeTool<Input>({
      name: 'getHRV',
      description: 'HRV data',
      inputSchema: schema,
      impl,
      analytics: engine,
      audit,
      budget: defaultBudget,
      ctxProvider: () => baseCtx,
      clock: () => {
        const cur = tick
        tick += 5
        return cur
      },
    })
    const out = await t.execute!({ userId: 'alice', days: 7 }, {} as any)
    expect(out).toBe('hello world')
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].outcome).toBe('success')
    expect(audit.records[0].resultRowCount).toBe(3)
    expect(audit.records[0].resultBytes).toBe(11)
    expect(audit.records[0].latencyMs).toBeGreaterThan(0)
    expect(audit.records[0].errorMessage).toBeNull()
  })

  it('rate-limited path returns short-circuit string and audits rate_limited', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const limiter = createFakeLimiter(false)
    const impl = vi.fn<ToolImpl<Input>>(async () => makeResult('nope'))
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      rateLimiter: limiter,
      audit,
      budget: defaultBudget,
      ctxProvider: () => baseCtx,
    })
    const out = await t.execute!({ userId: 'alice', days: 7 }, {} as any)
    expect(out).toContain('Rate limit')
    expect(impl).not.toHaveBeenCalled()
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0].outcome).toBe('rate_limited')
    expect(limiter.calls).toEqual(['getHRV:alice'])
  })

  it('authorize-reject returns not-authorized string and audits authorized_reject', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const impl = vi.fn<ToolImpl<Input>>(async () => makeResult('secret'))
    const authorize: AuthorizeFn = async () => false
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      authorize,
      audit,
      budget: defaultBudget,
      ctxProvider: () => baseCtx,
    })
    const out = await t.execute!({ userId: 'bob', days: 7 }, {} as any)
    expect(out).toContain('Not authorized')
    expect(impl).not.toHaveBeenCalled()
    expect(audit.records[0].outcome).toBe('authorized_reject')
  })

  it('execute throw returns error string and audits error with errorMessage', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const impl: ToolImpl<Input> = async () => {
      throw new Error('warehouse down')
    }
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      audit,
      budget: defaultBudget,
      ctxProvider: () => baseCtx,
    })
    const out = await t.execute!({ userId: 'alice', days: 7 }, {} as any)
    expect(out).toBe('Tool call failed.')
    expect(audit.records[0].outcome).toBe('error')
    expect(audit.records[0].errorMessage).toBe('warehouse down')
  })

  it('chain order: rate limit fires before authorize; authorize before execute', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const order: string[] = []
    const limiter: RateLimiter = {
      check() { order.push('rate'); return true },
    }
    const authorize: AuthorizeFn = async () => {
      order.push('auth')
      return true
    }
    const impl: ToolImpl<Input> = async () => {
      order.push('execute')
      return makeResult('ok')
    }
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      rateLimiter: limiter,
      authorize,
      audit,
      budget: defaultBudget,
      ctxProvider: () => baseCtx,
    })
    await t.execute!({ userId: 'alice', days: 7 }, {} as any)
    expect(order).toEqual(['rate', 'auth', 'execute'])
  })

  it('applies output budget: oversized result is truncated with suffix', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const bigText = 'x'.repeat(5000)
    const impl: ToolImpl<Input> = async () => makeResult(bigText)
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      audit,
      budget: { maxBytes: 1024, maxRows: 100 },
      ctxProvider: () => baseCtx,
    })
    const out = (await t.execute!({ userId: 'alice', days: 7 }, {} as any)) as string
    expect(out.endsWith('\n[truncated]')).toBe(true)
    expect(new TextEncoder().encode(out).byteLength).toBeLessThanOrEqual(1024)
    expect(audit.records[0].outcome).toBe('success')
    expect(audit.records[0].resultBytes).toBeLessThanOrEqual(1024)
  })

  it('ctxProvider invoked on every execute (supports mutable per-request ctx)', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const provided: ToolContext[] = []
    let currentCtx: ToolContext = baseCtx
    const impl: ToolImpl<Input> = async () => makeResult('ok')
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      audit,
      budget: defaultBudget,
      ctxProvider: () => {
        provided.push(currentCtx)
        return currentCtx
      },
    })
    await t.execute!({ userId: 'alice', days: 7 }, {} as any)
    currentCtx = { ...baseCtx, requesterUserId: 'bob', familyId: 'fam-2' }
    await t.execute!({ userId: 'bob', days: 7 }, {} as any)
    expect(provided).toHaveLength(2)
    expect(provided[0].requesterUserId).toBe('alice')
    expect(provided[1].requesterUserId).toBe('bob')
    expect(audit.records[1].familyId).toBe('fam-2')
  })

  it('missing ctx returns error string and audits error outcome', async () => {
    const engine = createFakeEngine()
    const audit = createFakeAudit()
    const impl = vi.fn<ToolImpl<Input>>(async () => makeResult('ok'))
    const t = makeTool<Input>({
      name: 'getHRV',
      description: '',
      inputSchema: schema,
      impl,
      analytics: engine,
      audit,
      budget: defaultBudget,
      ctxProvider: () => null,
    })
    const out = await t.execute!({ userId: 'alice', days: 7 }, {} as any)
    expect(out).toContain('context not set')
    expect(impl).not.toHaveBeenCalled()
    expect(audit.records[0].outcome).toBe('error')
    expect(audit.records[0].errorMessage).toBe('context not set')
  })
})

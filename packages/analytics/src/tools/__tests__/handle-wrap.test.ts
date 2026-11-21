/**
 * `handle.wrap` puts a host's own tool through the pack tools' chain:
 * validation, the shared rate limiter, authorization, every copy guard, the
 * budget and the same audit writer. Before 0.61.1 a host tool handed to the
 * model directly had none of them.
 */

import type { PackTool } from '../../core/packs'
import type { AuditEntry, AuditWriter, ToolContext } from '../types'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { definePack, registerPack, resetPacks } from '../../core/packs'
import { createFakeEngine } from '../__fakes__/engine'
import { createAnalyticsTools } from '../factory'

const ctx: ToolContext = { requesterUserId: 'alice', brand: 'acme', familyId: 'fam-1' }

function fakeAudit(): AuditWriter & { records: AuditEntry[] } {
  const records: AuditEntry[] = []
  return { records, record: e => records.push(e), flush: async () => {}, close: async () => {} }
}

function hostTool(text = 'Reading for 2026-11-20: fine.'): PackTool {
  return {
    description: 'A host tool.',
    inputSchema: z.object({ userId: z.string(), day: z.string().optional() }),
    impl: async () => ({ text, rowCount: 1, bytes: new TextEncoder().encode(text).byteLength }),
  }
}

function setup(opts: { perTool?: number, members?: string[] } = {}) {
  const audit = fakeAudit()
  const handle = createAnalyticsTools({
    analytics: createFakeEngine(),
    rateLimit: { perToolPerMinute: opts.perTool ?? 20, perToolPerHour: 200, perUserPerMinute: 60 },
    familyMembersProvider: async () => opts.members ?? ['alice'],
    clock: () => 1_000,
  })
  // Swap the audit writer's `record` for the fake's, keeping the shared writer object.
  handle.auditWriter.record = audit.record
  handle.setContext(ctx)
  return { handle, audit }
}

function call(t: { execute?: (...a: never[]) => unknown }, args: unknown) {
  return (t.execute as (a: unknown, o: object) => Promise<string>)(args, {})
}

afterEach(() => resetPacks())

describe('handle.wrap', () => {
  it('audits a successful call in tool_call_audit like a pack tool', async () => {
    const { handle, audit } = setup()
    const t = handle.wrap('getReadingDay', hostTool())
    expect(await call(t, { userId: 'alice', day: 'yesterday' })).toBe('Reading for 2026-11-20: fine.')
    expect(audit.records).toHaveLength(1)
    expect(audit.records[0]).toMatchObject({
      toolName: 'getReadingDay',
      outcome: 'success',
      requesterUserId: 'alice',
      args: { userId: 'alice', day: 'yesterday' },
      resultRowCount: 1,
    })
  })

  it('shares the rate limiter: the call over the per-tool limit is refused and audited', async () => {
    const { handle, audit } = setup({ perTool: 2 })
    const t = handle.wrap('getReadingDay', hostTool())
    await call(t, { userId: 'alice' })
    await call(t, { userId: 'alice' })
    expect(await call(t, { userId: 'alice' })).toBe('Rate limit exceeded. Try again shortly.')
    expect(audit.records.map(r => r.outcome)).toEqual(['success', 'success', 'rate_limited'])
  })

  it('authorizes: another person\'s data is refused', async () => {
    const { handle, audit } = setup({ members: ['alice'] })
    const t = handle.wrap('getReadingDay', hostTool())
    expect(await call(t, { userId: 'mallory' })).toBe('Not authorized to access that user\'s data.')
    expect(audit.records[0].outcome).toBe('authorized_reject')
  })

  it('validates its arguments', async () => {
    const { handle } = setup()
    const t = handle.wrap('getReadingDay', hostTool())
    expect(await call(t, { userId: 'alice', day: 3 })).toBe('Invalid arguments: day must be a string (got 3).')
  })

  it('runs every registered copy guard over the text', async () => {
    registerPack(definePack({
      name: 'guardtest',
      copyGuard: (text: string, source: string) => {
        if (text.includes('forbidden'))
          throw new Error(`${source}: forbidden word`)
      },
    }))
    const { handle, audit } = setup()
    const t = handle.wrap('getReadingDay', hostTool('A forbidden word.'))
    expect(await call(t, { userId: 'alice' })).toBe('Tool call failed.')
    expect(audit.records[0]).toMatchObject({ outcome: 'error', errorMessage: 'getReadingDay: forbidden word' })
  })

  it('refuses a name a pack tool already has', () => {
    const { handle } = setup()
    const taken = Object.keys(handle.tools)[0]
    expect(() => handle.wrap(taken, hostTool())).toThrow(/already a pack tool/)
  })

  it('is not added to handle.tools', () => {
    const { handle } = setup()
    handle.wrap('getReadingDay', hostTool())
    expect(Object.keys(handle.tools)).not.toContain('getReadingDay')
  })
})

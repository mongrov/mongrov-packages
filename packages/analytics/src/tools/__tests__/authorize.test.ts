import { describe, expect, it } from 'vitest'
import { createFakeEngine } from '../__fakes__/engine'
import { familyScopeAuthorize, orgScopeAuthorize } from '../authorize'

const baseCtx = {
  requesterUserId: 'alice',
  brand: 'zivaone',
  familyId: 'fam-1',
}

describe('familyScopeAuthorize', () => {
  it('allows self-target without hitting SQL', async () => {
    const engine = createFakeEngine()
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'alice' }, baseCtx)).toBe(true)
    expect(engine.calls).toHaveLength(0)
  })

  it('allows target found in family_member', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM family_member', [{ one: 1 }])
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(true)
    expect(engine.calls[0].params).toEqual({
      familyId: 'fam-1',
      userId: 'bob',
    })
  })

  it('denies target not in family_member', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM family_member', [])
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'eve' }, baseCtx)).toBe(false)
  })

  it('denies missing args.userId without hitting SQL', async () => {
    const engine = createFakeEngine()
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', {}, baseCtx)).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('denies non-string args.userId without hitting SQL', async () => {
    const engine = createFakeEngine()
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 42 }, baseCtx)).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('denies empty-string args.userId without hitting SQL', async () => {
    const engine = createFakeEngine()
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: '' }, baseCtx)).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('fails closed when engine throws', async () => {
    const engine = createFakeEngine()
    engine.setError(new Error('not_ready'))
    const auth = familyScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(false)
  })
})

describe('orgScopeAuthorize', () => {
  it('allows self-target', async () => {
    const engine = createFakeEngine()
    const auth = orgScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'alice' }, baseCtx)).toBe(true)
    expect(engine.calls).toHaveLength(0)
  })

  it('queries org_member with orgId bound from ctx.familyId (v0.1.0 shim)', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM org_member', [{ one: 1 }])
    const auth = orgScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(true)
    expect(engine.calls[0].sql).toContain('FROM org_member')
    expect(engine.calls[0].params).toEqual({
      orgId: 'fam-1',
      userId: 'bob',
    })
  })

  it('denies target not in org_member', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM org_member', [])
    const auth = orgScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'eve' }, baseCtx)).toBe(false)
  })

  it('fails closed when engine throws', async () => {
    const engine = createFakeEngine()
    engine.setError(new Error('not_ready'))
    const auth = orgScopeAuthorize(engine)
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(false)
  })
})

describe('familyScopeAuthorize with familyMembersProvider', () => {
  it('allows target present in provider result without hitting SQL', async () => {
    const engine = createFakeEngine()
    const provider = async () => ['alice', 'bob', 'carol']
    const auth = familyScopeAuthorize(engine, {
      familyMembersProvider: provider,
    })
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(true)
    expect(engine.calls).toHaveLength(0)
  })

  it('denies target absent from provider result', async () => {
    const engine = createFakeEngine()
    const provider = async () => ['alice', 'bob']
    const auth = familyScopeAuthorize(engine, {
      familyMembersProvider: provider,
    })
    expect(await auth('getHRV', { userId: 'eve' }, baseCtx)).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('fails closed when provider throws', async () => {
    const engine = createFakeEngine()
    const provider = async () => {
      throw new Error('provider_unavailable')
    }
    const auth = familyScopeAuthorize(engine, {
      familyMembersProvider: provider,
    })
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('provider path takes precedence when both engine + provider present', async () => {
    const engine = createFakeEngine()
    engine.queueRows('FROM family_member', [{ one: 1 }])
    const provider = async () => [] // provider says no
    const auth = familyScopeAuthorize(engine, {
      familyMembersProvider: provider,
    })
    // provider says bob is not a member, so authorize denies even
    // though SQL would say yes — provider wins.
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(false)
    expect(engine.calls).toHaveLength(0)
  })

  it('passes ctx.brand + ctx.familyId to provider', async () => {
    const engine = createFakeEngine()
    const received: { brand: string, familyId: string }[] = []
    const provider = async (args: { brand: string, familyId: string }) => {
      received.push(args)
      return ['bob']
    }
    const auth = familyScopeAuthorize(engine, {
      familyMembersProvider: provider,
    })
    await auth('getHRV', { userId: 'bob' }, baseCtx)
    expect(received).toEqual([{ brand: 'zivaone', familyId: 'fam-1' }])
  })
})

describe('orgScopeAuthorize with familyMembersProvider', () => {
  it('uses provider for membership check (v0.1.0 shim)', async () => {
    const engine = createFakeEngine()
    const provider = async () => ['alice', 'bob']
    const auth = orgScopeAuthorize(engine, {
      familyMembersProvider: provider,
    })
    expect(await auth('getHRV', { userId: 'bob' }, baseCtx)).toBe(true)
    expect(engine.calls).toHaveLength(0)
  })
})

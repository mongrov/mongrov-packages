/**
 * Fake AttachDeps for warehouse.test.ts.
 *
 * Captures each dep invocation so tests can assert order, and lets tests
 * script individual step failures.
 *
 * Not a test file (no `.test.ts` suffix); vitest's include glob skips it.
 */

import type { FamilyMembersProvider, TokenContext, TokenResponse, TokenVendor } from '../../types'
import type { AttachDeps } from '../../warehouse'

export interface FakeAttachDeps {
  deps: AttachDeps
  /** Call history for each dep, in invocation order. */
  builderCalls: { brand: string, tenantScope: string, tenantId: string }[]
  tokenCalls: TokenContext[]
  familyCalls: { brand: string, familyId: string }[]
  /** Script builder failure on the next call. */
  failBuilder: (err: unknown) => void
  /** Script token vendor failure on the next call. */
  failToken: (err: unknown) => void
  /** Script family provider failure on the next call. */
  failFamily: (err: unknown) => void
  /** Override the token expiry the vendor returns. Defaults to now + 1h. */
  setTokenExpiresAt: (when: Date) => void
}

export interface CreateFakeAttachDepsOptions {
  catalogEndpoint?: string
  uri?: string
  familyMemberIds?: string[]
}

export function createFakeAttachDeps(
  options: CreateFakeAttachDepsOptions = {},
): FakeAttachDeps {
  const builderCalls: FakeAttachDeps['builderCalls'] = []
  const tokenCalls: TokenContext[] = []
  const familyCalls: FakeAttachDeps['familyCalls'] = []

  let builderError: unknown
  let tokenError: unknown
  let familyError: unknown
  let tokenExpiresAt = new Date(Date.now() + 60 * 60 * 1000)

  const uri = options.uri ?? 's3://mongrov-analytics/brandA/fam123/warehouse'
  const familyMemberIds = options.familyMemberIds ?? ['user-1', 'user-2']

  const tokenVendor: TokenVendor = {
    async fetch(context) {
      tokenCalls.push(context)
      if (tokenError !== undefined) {
        const err = tokenError
        tokenError = undefined
        throw err
      }
      const resp: TokenResponse = {
        token: 'fake-bearer-token',
        expiresAt: tokenExpiresAt,
        scopeClaims: {
          brand: context.brand,
          tenantScope: context.tenantScope,
          tenantId: context.tenantId,
          permissions: ['read', 'write'],
        },
      }
      return resp
    },
  }

  const familyMembersProvider: FamilyMembersProvider = async (ctx) => {
    familyCalls.push(ctx)
    if (familyError !== undefined) {
      const err = familyError
      familyError = undefined
      throw err
    }
    return familyMemberIds
  }

  const deps: AttachDeps = {
    warehouseUriBuilder(brand, tenantScope, tenantId) {
      builderCalls.push({ brand, tenantScope, tenantId })
      if (builderError !== undefined) {
        const err = builderError
        builderError = undefined
        throw err
      }
      return uri
    },
    tokenVendor,
    familyMembersProvider,
    catalogEndpoint: options.catalogEndpoint ?? 'https://catalog.example/iceberg',
  }

  return {
    deps,
    builderCalls,
    tokenCalls,
    familyCalls,
    failBuilder(err) {
      builderError = err
    },
    failToken(err) {
      tokenError = err
    },
    failFamily(err) {
      familyError = err
    },
    setTokenExpiresAt(when) {
      tokenExpiresAt = when
    },
  }
}

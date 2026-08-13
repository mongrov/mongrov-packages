/**
 * KVStore-backed persistence for analytics state.
 *
 * Two concerns:
 *
 *   1. **Last-attach ctx** — persisted on every successful attach and cleared
 *      on detach. `loadLastAttach` returns the ctx only if it was written
 *      within `LAST_ATTACH_TTL_MS` (24h per spec §Testing) so apps can safely
 *      auto-reattach after a crash / cold start without silently reviving a
 *      stale multi-day-old context.
 *
 *   2. **Retention override** — `setRetention(days)` persists the user
 *      override layer per spec §Retention precedence at
 *      `analytics:retention:override:{brand}:{tenantId}:{userId}`. v0.1.0
 *      resolves via `resolveEffectiveRetention` (retention.ts) but does not
 *      surface UX to write it (`analytics.setRetention` is the escape hatch).
 *
 * All keys use the `analytics:` prefix so consumers can namespace-clear.
 */

import type { AttachContext, KVStore } from './types'

// -------------------- keys --------------------

/** 24h in ms — freshness bound for the persisted attach ctx. */
export const LAST_ATTACH_TTL_MS = 24 * 60 * 60 * 1000

function lastAttachKey(brand: string): string {
  return `analytics:last-attach:${brand}`
}

function retentionOverrideKey(brand: string, tenantId: string, userId: string): string {
  return `analytics:retention:override:${brand}:${tenantId}:${userId}`
}

// -------------------- last attach --------------------

interface LastAttachRecord {
  ctx: AttachContext
  attachedAt: number
}

/**
 * Persist the ctx that just successfully attached. Overwrites any prior
 * entry for the same brand.
 */
export async function saveLastAttach(
  kv: KVStore,
  ctx: AttachContext,
  now: number = Date.now(),
): Promise<void> {
  const record: LastAttachRecord = { ctx, attachedAt: now }
  await kv.set(lastAttachKey(ctx.brand), record)
}

/**
 * Load the last attach ctx for `brand` if it was written within the TTL.
 * Returns `null` for missing entries or entries older than
 * `LAST_ATTACH_TTL_MS`. Stale entries are also deleted as a side effect so
 * repeated reads don't keep resurfacing them.
 */
export async function loadLastAttach(
  kv: KVStore,
  brand: string,
  now: number = Date.now(),
): Promise<AttachContext | null> {
  const record = await kv.get<LastAttachRecord>(lastAttachKey(brand))
  if (!record)
    return null
  if (now - record.attachedAt > LAST_ATTACH_TTL_MS) {
    // Best-effort cleanup — swallow errors so a flaky KV can't wedge callers.
    try {
      await kv.delete(lastAttachKey(brand))
    }
    catch { /* ignore */ }
    return null
  }
  return record.ctx
}

/**
 * Clear the persisted attach ctx for `brand`. Invoked on `detach()` so a
 * subsequent open doesn't auto-restore a context the app deliberately left.
 */
export async function clearLastAttach(kv: KVStore, brand: string): Promise<void> {
  await kv.delete(lastAttachKey(brand))
}

// -------------------- retention override --------------------

interface RetentionOverrideRecord {
  days: number
  updatedAt: number
}

/**
 * Persist the user-override retention for the current attach context.
 * Overwrites any prior override for the same `(brand, tenantId, userId)`.
 */
export async function saveRetentionOverride(
  kv: KVStore,
  ctx: AttachContext,
  days: number,
  now: number = Date.now(),
): Promise<void> {
  const record: RetentionOverrideRecord = { days, updatedAt: now }
  await kv.set(retentionOverrideKey(ctx.brand, ctx.tenantId, ctx.userId), record)
}

/**
 * Load the user-override retention (days) for `(brand, tenantId, userId)`,
 * or `null` when none is stored.
 */
export async function loadRetentionOverride(
  kv: KVStore,
  ctx: AttachContext,
): Promise<number | null> {
  const record = await kv.get<RetentionOverrideRecord>(
    retentionOverrideKey(ctx.brand, ctx.tenantId, ctx.userId),
  )
  return record ? record.days : null
}

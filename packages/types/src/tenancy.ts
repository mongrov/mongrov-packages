/**
 * Multi-brand tenancy entities (spec.md §18 — Multi-brand entity additions).
 *
 * Zero runtime — interfaces only, per the package contract.
 *
 * Identity model (principles 10–13):
 *   - One binary serves multiple brands; brand is part of every identity.
 *   - `(brand, userId)` is the composite identity. The same email may hold an
 *     account on ZivaOne and on Viva; they are different accounts with
 *     different sessions, and nothing joins across them device-side.
 *   - v1 invariant: one family per user (principle 12).
 *   - A user removed from a family keeps their data under their `userId`;
 *     there is no cascade delete (principle 13).
 */

/**
 * A brand tenant — ZivaOne, Viva, YogaRing (consumer, family-scoped) or
 * LuminX (enterprise, org-scoped).
 *
 * `tenantScope` selects the warehouse partitioning strategy: `'family'`
 * warehouses are keyed by `familyId`, `'org'` warehouses by org id.
 */
export interface Brand {
  id: string
  name: string
  tenantScope: 'family' | 'org'
}

/**
 * A family group. Analytics warehouses for consumer brands are family-scoped,
 * so this is the unit R2 zones are provisioned against.
 *
 * `memberIds` is **denormalized onto the doc deliberately** (Sprint 3
 * precondition for `analytics-core`): the rules engine and AI tools both
 * authorize against family membership on every evaluation and every tool
 * call, and neither may reach into RxDB or auth state directly (principle
 * 39). The app's `FamilyMembersProvider` reads this array; analytics caches
 * it for 60s behind `analytics.getFamilyMembers()`.
 */
export interface Family {
  id: string
  /** Brand id — families never span brands. */
  brand: string
  name?: string
  ownerId: string
  /** ISO 8601. */
  createdAt: string
  /** Denormalized member userIds — see note above. */
  memberIds: string[]
}

/**
 * An authenticated user, scoped to one brand.
 *
 * `timezone` is load-bearing rather than cosmetic: `analytics/sync`'s mapper
 * needs an IANA zone to attribute sleep sessions to the correct local
 * "night" via the 6pm–6pm rule (principle 24), and baseline compute needs it
 * to group readings by local day. Captured at sign-up, falling back to the
 * device timezone when the profile has none.
 */
export interface User {
  id: string
  /** Required — half of the `(brand, userId)` composite identity. */
  brand: string
  /** Absent until the user joins or creates a family (principle 12: at most one). */
  familyId?: string
  /** IANA zone, e.g. `'America/Los_Angeles'`. */
  timezone?: string
  email?: string
  displayName?: string
  avatarUrl?: string
}

/**
 * A paired hardware device as the analytics plane models it — ring, band, or
 * asset tracker.
 *
 * Named `AnalyticsDevice` rather than `Device` because `./device.ts` already
 * exports a `Device` describing the BLE transport's view (adapter id,
 * connection state, RSSI). Both are legitimate and neither is a superset:
 * this one is the durable tenancy record that sensor rows carry a foreign
 * key to; that one is the live connection handle.
 *
 * `id = hash(brand + hardware_id)` (principle 26) — the same physical ring
 * paired to two brand accounts yields two distinct ids, so cross-brand
 * correlation is impossible device-side even by accident.
 */
export interface AnalyticsDevice {
  /** `hash(brand + hardware_id)` — opaque, stable, brand-scoped. */
  id: string
  userId: string
  familyId: string
  brand: string
  /** Hardware class, e.g. `'ring' | 'band' | 'tracker'`. Open string set. */
  type: string
  model?: string
  firmwareVersion?: string
  /** ISO 8601. */
  pairedAt: string
  /** ISO 8601. */
  lastSeenAt?: string
}

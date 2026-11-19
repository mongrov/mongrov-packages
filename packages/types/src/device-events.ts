/**
 * Device lifecycle event types + per-type payload schemas.
 *
 * **Canonical home.** `@mongrov/analytics` re-exports these so its consumers
 * need only one import, and `@mongrov/device` imports them directly — the
 * device package must never depend on the analytics engine, but it does
 * need to emit events an app may store.
 *
 * No `@mongrov/*` package defines a table for these events; an app that
 * stores them (for example in an events table registered by its own pack)
 * typically keeps the payload as a string column of serialized JSON, so
 * nothing about its contents is enforced by the database. These schemas are
 * that enforcement: producers validate before writing, consumers validate
 * after reading, and a reader of `sync_completed` payloads can rely on them
 * carrying the fields it reads.
 *
 */

import { z } from 'zod'

/**
 * Every legal device event type.
 *
 * Ordered by lifecycle: pairing, connection, telemetry, firmware, sync.
 */
export const DEVICE_EVENT_TYPES = [
  'paired',
  'unpaired',
  'connected',
  'disconnected',
  'battery_sample',
  'battery_low',
  'firmware_updated',
  'sync_started',
  'sync_completed',
  'sync_failed',
] as const

export type DeviceEventType = (typeof DEVICE_EVENT_TYPES)[number]

/**
 * What kicked off a sync cycle. `background` is the OS-scheduled task,
 * `auto` is an app-lifecycle trigger (foreground, device connect), and
 * `manual` is user-initiated and bypasses battery/network constraints.
 */
export const SyncTrigger = z.enum(['auto', 'manual', 'background'])
export type SyncTriggerValue = z.infer<typeof SyncTrigger>

const EmptyPayload = z.object({}).strict()

/**
 * Payload schema per event type. Every schema is `.strict()` — an unknown
 * key means the producer and this contract have diverged, and silently
 * dropping it would hide the drift until a consumer read a missing field.
 */
export const DEVICE_EVENT_PAYLOAD_SCHEMAS = {
  paired: EmptyPayload,
  unpaired: EmptyPayload,
  connected: EmptyPayload,
  disconnected: EmptyPayload,

  /** Routine battery telemetry. */
  battery_sample: z.object({
    level: z.number().min(0).max(100),
  }).strict(),

  /** Crossed a low-battery threshold; carries the threshold for context. */
  battery_low: z.object({
    level: z.number().min(0).max(100),
    threshold: z.number().min(0).max(100),
  }).strict(),

  firmware_updated: z.object({
    fromVersion: z.string(),
    toVersion: z.string(),
  }).strict(),

  sync_started: z.object({
    trigger: SyncTrigger,
  }).strict(),

  /**
   * Backs the "Updated N min ago" label. `rowsWritten` may legitimately be
   * 0 — a cycle that found nothing new still completed, and the label
   * should still refresh.
   */
  sync_completed: z.object({
    trigger: SyncTrigger,
    rowsWritten: z.number().int().nonnegative(),
    latencyMs: z.number().int().nonnegative(),
  }).strict(),

  sync_failed: z.object({
    trigger: SyncTrigger,
    error: z.string(),
    retryCount: z.number().int().nonnegative(),
  }).strict(),
} as const satisfies Record<DeviceEventType, z.ZodTypeAny>

export type DeviceEventPayload<T extends DeviceEventType> = z.infer<
  (typeof DEVICE_EVENT_PAYLOAD_SCHEMAS)[T]
>

/** Narrow an arbitrary string to a known event type. */
export function isDeviceEventType(value: string): value is DeviceEventType {
  return (DEVICE_EVENT_TYPES as readonly string[]).includes(value)
}

/**
 * Validate a payload against its event type and return it serialized for
 * a string payload column.
 *
 * Throws `ZodError` on mismatch rather than writing a row a consumer
 * cannot parse — a malformed event is worth failing the write for, since
 * the alternative is a silently unreadable audit trail.
 */
export function encodeDeviceEventPayload<T extends DeviceEventType>(
  eventType: T,
  payload: DeviceEventPayload<T>,
): string {
  const schema = DEVICE_EVENT_PAYLOAD_SCHEMAS[eventType]
  return JSON.stringify(schema.parse(payload))
}

/**
 * Parse a serialized event payload string back to its typed shape.
 *
 * Returns `null` rather than throwing when the row is unparseable: read
 * paths (the "Updated N min ago" label, insight feeds) should degrade to
 * "unknown" on one bad historical row, not crash the screen.
 */
export function decodeDeviceEventPayload<T extends DeviceEventType>(
  eventType: T,
  raw: string | null | undefined,
): DeviceEventPayload<T> | null {
  if (typeof raw !== 'string' || raw.length === 0)
    return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  const result = DEVICE_EVENT_PAYLOAD_SCHEMAS[eventType].safeParse(parsed)
  return result.success ? (result.data as DeviceEventPayload<T>) : null
}

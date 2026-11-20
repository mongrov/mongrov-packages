/**
 * Device lifecycle event types + per-type payload schemas (Sprint 5 §6).
 *
 * **Re-export only.** The canonical definition lives in
 * `@mongrov/types/device-events`, so that `@mongrov/device` — which must
 * never depend on the analytics engine — emits events against the same
 * contract a pack uses to validate and store them. The engine itself
 * declares no table for them.
 *
 * Kept as a module here so analytics consumers get one import surface, and
 * so the `core/index.ts` export list stays stable.
 */

export {
  decodeDeviceEventPayload,
  DEVICE_EVENT_PAYLOAD_SCHEMAS,
  DEVICE_EVENT_TYPES,
  encodeDeviceEventPayload,
  isDeviceEventType,
  SyncTrigger,
} from '@mongrov/types/device-events'

export type {
  DeviceEventPayload,
  DeviceEventType,
  SyncTriggerValue,
} from '@mongrov/types/device-events'

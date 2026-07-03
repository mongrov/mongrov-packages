/**
 * global-interrupts — wiring glue from behavioral ports to the registry.
 *
 * NOT a state machine. Pure glue: subscribes to the injected
 * `LifecyclePort` (and optionally native BT / permission emitters) and
 * translates their events into `BT_OFF` / `PERMISSION_REVOKED` /
 * `BACKGROUNDED` / `RESUMED` sent into the registry.
 *
 * Returns an unsubscribe-all function; app tears down at logout / provider
 * unmount.
 *
 * Rationale: the device package assumes `react-native-permissions` and BT
 * state emitters live in the app layer (per design.md §3). We accept them
 * as opaque subscription functions so the package stays free of native
 * platform imports.
 */

import type { LifecyclePort } from '../ports'
import type { RegistryEvent } from '../registry/registry-machine'

export type NativeUnsubscribe = () => void

export interface OptionalNativeSources {
  /**
   * Subscribe to bluetooth on/off state. `on === true` → `RESUMED`;
   * `on === false` → `BT_OFF`.
   */
  onBluetoothStateChange?: (
    listener: (on: boolean) => void,
  ) => NativeUnsubscribe

  /**
   * Subscribe to permission changes (Bluetooth / location).
   * `granted === false` → `PERMISSION_REVOKED`; `granted === true` → `RESUMED`.
   */
  onPermissionChange?: (
    listener: (granted: boolean) => void,
  ) => NativeUnsubscribe
}

export interface BindGlobalInterruptsArgs {
  send: (event: RegistryEvent) => void
  lifecycle: LifecyclePort
  native?: OptionalNativeSources
}

/**
 * Wire lifecycle + optional native sources into the registry.
 *
 * @returns Unsubscribe-all function.
 */
export function bindGlobalInterrupts(
  args: BindGlobalInterruptsArgs,
): NativeUnsubscribe {
  const { send, lifecycle, native } = args

  const unsubs: NativeUnsubscribe[] = []

  unsubs.push(
    lifecycle.subscribe((state) => {
      send({ type: state === 'background' ? 'BACKGROUNDED' : 'RESUMED' })
    }),
  )

  if (native?.onBluetoothStateChange) {
    unsubs.push(
      native.onBluetoothStateChange((on) => {
        send({ type: on ? 'RESUMED' : 'BT_OFF' })
      }),
    )
  }

  if (native?.onPermissionChange) {
    unsubs.push(
      native.onPermissionChange((granted) => {
        send({ type: granted ? 'RESUMED' : 'PERMISSION_REVOKED' })
      }),
    )
  }

  return () => {
    while (unsubs.length > 0) {
      const u = unsubs.pop()
      if (u) u()
    }
  }
}

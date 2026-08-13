/**
 * Timeseries engine subpath: `@mongrov/db/timeseries`
 *
 * Append-only storage for `DeviceReading` streams. Implements the
 * `ReadingSink` + `ConfigStore` ports declared by `@mongrov/device`.
 *
 * **D1 status:** types only. Engine implementation lands in D3
 * (`TimonEngine` adapter + RxDB fallback). See `features/db/design.md` §2 + §7.
 *
 * Apps using device today inject mocked ports; switch the import once D3 ships.
 */

// Port + engine contracts — implementation pending D3.
export type {
  DBLogger,
  ReadingSink,
  RemoteTarget,
  TimeseriesEngine,
  TimeseriesHWM,
} from './types'

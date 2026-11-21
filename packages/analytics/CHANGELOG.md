# Changelog

## [0.61.1] - 2026-11-21

Fixes to the AI tool framework (`@mongrov/analytics/tools`). Tool names and
the shape of their text are unchanged; two additive exports.

### Fixed

- Tool arguments are validated. `makeTool` parses every call with the tool's
  Zod schema before anything else runs, so `.default()` values apply and every
  bound holds, whatever the caller checked: the AI SDK's `jsonSchema()` has no
  validator, an on-device bridge may keep only one numeric bound, and MCP
  passed arguments straight through. A refused call returns
  `Invalid arguments: days must be a whole number from 1 to 90 (got 0).` and is
  audited as `error` with an `invalid_args:` message.
- The JSON Schema given to the model is the input view: a field with a
  default is optional (zod 4 listed it in `required`) and carries its default.
- Every registered `copyGuard` runs over every tool's text in the wrapper,
  not only where an impl called it.
- The output budget drops dated rows oldest first and always keeps the header
  and summary lines, with one `[truncated: N earlier rows left out]` line in
  their place. It used to cut from the end, losing the newest rows and the
  summary first. Text without dated rows is cut as before.
- MCP: `isError: true` for refused arguments, rate-limited, unauthorized,
  context-less and failed calls; the text is unchanged.
- `getInsights` prints insight times in the user's zone (it printed naive UTC
  with no marker), and its description lists exactly what it takes and returns.

### Added

- `handle.wrap(name, def)` on `createAnalyticsTools`' handle: runs a host's
  own tool through the same chain as pack tools (validation, the shared rate
  limiter, authorization, copy guards, budget, the same audit writer).
- `trimOldestRows(text, fits, marker)`: the budget's row-dropping rule, for a
  host's own, smaller cap.

## [0.61.0] - 2026-11-20

Additive: no change to existing exports or behaviour.

### Added

- `@mongrov/analytics/testing`: the engine's pure modules — pack registry
  (with `resetPacks` for test isolation), DDL and schema helpers, platform
  tables, metric and relation lookups, bounded reads, errors, and from
  `/sync` the baseline runner, ingest drop accounting, `mergeFlushResults`
  and `logError` — for an app's test double of this package. Same names and
  module instances as the root and `/sync` exports; no native module, no
  React, no side effect on import. Replaces deep imports of `dist/` files.
- `userSettingKey(userId, key)` (root and `/rules`): the `KVStore` key the
  rules engine reads a `user_setting` threshold or `phase_band` scale from
  (`analytics:<userId>:<key>`), so an app or pack writing those settings no
  longer restates the prefix. The rules engine reads through it.

### Changed

- README: the quick start compiles against the current API (`tokenVendor`
  returns `scopeClaims`; attach is on the engine, `useAnalytics()` reports
  state); links to files that do not ship point at the repository.
- `UPGRADING.md` no longer links to pre-0.60 notes; those ship in the
  earlier versions' own `UPGRADING.md`.
- Comments no longer name a pack's tables.

## [0.60.1] - 2026-11-19

### Fixed

- The platform pack's starting migration version is persisted even when it
  is 0, so an interrupted first attach retries the platform migrations instead of
  skipping them.
- Post-flush jobs and after-push hooks are isolated per job: one that throws
  is logged and skipped, and the rest of the flush (or sync cycle) still runs.
- Name collisions between registered packs — ingest adapters, rule contexts
  and tools — throw `AnalyticsError('invalid_config')` at registration, like
  table collisions. Before, the first adapter or context won and the last
  tool won, silently.
- The internal default-pack registration (used by the package's own test
  suites; not exported) validates its packs as `definePack` does.

### Changed

- Docs, comments and type docs are brand- and domain-free.
- Test fakes (`__fakes__`) and test directories are no longer compiled into
  `dist/`.
- `prepublishOnly` runs the domain-term guard over the files `npm pack` publishes.
- `UPGRADING.md` keeps only the 0.60 notes; earlier history moved to the
  repository (`docs/history/`).

## [0.60.0] - 2026-11-19

The engine is domain-free: a domain's tables, views, ingest adapters,
post-flush jobs, baselines, metrics, rules and tools arrive as a pack
(`definePack`, `registerPack`, `createAnalytics({ packs })`). Breaking for
imports; see [UPGRADING.md](./UPGRADING.md).
